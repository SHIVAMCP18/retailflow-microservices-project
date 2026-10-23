"""Customer Service (Python + MongoDB).

Owns customer profiles and accounts, and is the identity provider: it issues
RS256-signed JWTs that the gateway and every other service verify.
"""
import json
import logging
import os
import socket
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
import pika
from bson import ObjectId
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from prometheus_fastapi_instrumentator import Instrumentator
from pydantic import BaseModel, EmailStr, Field
from pymongo import MongoClient

ISSUER = "retailflow-customer-service"
PORT = int(os.getenv("PORT", "8000"))


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {"time": self.formatTime(record), "level": record.levelname, "service": "customer-service", "message": record.getMessage()}
        entry.update(getattr(record, "fields", {}))
        return json.dumps(entry)


handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
log = logging.getLogger("customer")
log.addHandler(handler)
log.setLevel(logging.INFO)


def info(message, **fields):
    log.info(message, extra={"fields": fields})


def read_secret(env_name, default_path):
    with open(os.getenv(env_name, default_path), "rb") as handle:
        return handle.read()


PRIVATE_KEY = read_secret("JWT_PRIVATE_KEY_FILE", "/run/secrets/jwt_private_key")
PUBLIC_KEY = read_secret("JWT_PUBLIC_KEY_FILE", "/run/secrets/jwt_public_key")

mongo = MongoClient(os.environ["MONGO_URL"], serverSelectionTimeoutMS=5000)
customers = mongo.customers.customers

app = FastAPI(title="Customer Service")
Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


# ---------- models ----------
class Address(BaseModel):
    line1: str
    city: str
    postcode: str


class Registration(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    phone: str | None = Field(default=None, max_length=20)


class Login(BaseModel):
    email: str = Field(max_length=200)
    password: str


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    phone: str | None = Field(default=None, max_length=20)
    address: Address | None = None


def public_view(doc):
    """Never return the password hash."""
    return {"id": str(doc["_id"]), "name": doc["name"], "email": doc["email"], "phone": doc.get("phone"),
            "address": doc.get("address"), "role": doc["role"], "status": doc["status"],
            "createdAt": doc["createdAt"].isoformat()}


# ---------- security ----------
def current_user(authorization: str = Header(default="")):
    try:
        return jwt.decode(authorization.removeprefix("Bearer "), PUBLIC_KEY, algorithms=["RS256"], issuer=ISSUER)
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or missing token")


def ensure_self_or_admin(user, customer_id):
    if user["role"] != "ADMIN" and user["sub"] != customer_id:
        raise HTTPException(403, "You can only access your own account")


def find(customer_id):
    try:
        doc = customers.find_one({"_id": ObjectId(customer_id)})
    except Exception:
        doc = None
    if not doc:
        raise HTTPException(404, "Customer not found")
    return doc


# ---------- events (asynchronous, RabbitMQ topic exchange) ----------
def publish(event_type, payload, request_id=None):
    """Publishes a domain event. Failures are logged, not raised: the account
    is already saved and a welcome notification is not business-critical."""
    try:
        params = pika.URLParameters(os.environ["RABBITMQ_URL"])
        with pika.BlockingConnection(params) as connection:
            channel = connection.channel()
            event = {"eventId": str(uuid.uuid4()), "eventType": event_type, "occurredAt": datetime.now(timezone.utc).isoformat(),
                     "correlationId": request_id, "payload": payload}
            channel.basic_publish("retailflow.events", event_type, json.dumps(event),
                                  pika.BasicProperties(content_type="application/json", delivery_mode=2))
            info("event.published", eventType=event_type, requestId=request_id)
    except Exception as error:
        log.warning("event publish failed: %s", error)


# ---------- endpoints ----------
@app.get("/health")
def health():
    mongo.admin.command("ping")
    return {"status": "UP", "service": "customer-service"}


@app.post("/auth/register", status_code=201)
def register(body: Registration, request: Request):
    if customers.find_one({"email": body.email.lower()}):
        raise HTTPException(409, "Email already registered")
    doc = {"name": body.name, "email": body.email.lower(), "phone": body.phone, "role": "CUSTOMER", "status": "ACTIVE",
           "passwordHash": bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode(),
           "createdAt": datetime.now(timezone.utc)}
    doc["_id"] = customers.insert_one(doc).inserted_id
    request_id = request.headers.get("x-request-id")
    info("customer.registered", customerId=str(doc["_id"]), requestId=request_id)
    publish("customer.registered", {"customerId": str(doc["_id"]), "name": doc["name"], "email": doc["email"], "phone": doc["phone"]}, request_id)
    return public_view(doc)


@app.post("/auth/login")
def login(body: Login):
    doc = customers.find_one({"email": body.email.lower()})
    if not doc or not bcrypt.checkpw(body.password.encode(), doc["passwordHash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    if doc["status"] != "ACTIVE":
        raise HTTPException(403, "Account is not active")
    now = datetime.now(timezone.utc)
    claims = {"iss": ISSUER, "sub": str(doc["_id"]), "role": doc["role"], "name": doc["name"], "email": doc["email"],
              "iat": now, "exp": now + timedelta(hours=1)}
    return {"token": jwt.encode(claims, PRIVATE_KEY, algorithm="RS256"), "tokenType": "Bearer", "expiresIn": 3600,
            "customerId": str(doc["_id"]), "role": doc["role"]}


@app.get("/customers")
def list_customers(user=Depends(current_user)):
    if user["role"] != "ADMIN":
        raise HTTPException(403, "Requires role ADMIN")
    return [public_view(doc) for doc in customers.find().sort("createdAt", 1)]


@app.get("/customers/me")
def me(user=Depends(current_user)):
    return public_view(find(user["sub"]))


@app.get("/customers/{customer_id}")
def get_customer(customer_id: str, user=Depends(current_user)):
    ensure_self_or_admin(user, customer_id)
    return public_view(find(customer_id))


@app.put("/customers/{customer_id}")
def update_customer(customer_id: str, body: ProfileUpdate, user=Depends(current_user)):
    ensure_self_or_admin(user, customer_id)
    find(customer_id)
    changes = body.model_dump(exclude_none=True)
    if changes:
        customers.update_one({"_id": ObjectId(customer_id)}, {"$set": changes})
    return public_view(find(customer_id))


# ---------- startup: indexes, admin account, Consul ----------
def seed_admin():
    customers.create_index("email", unique=True)
    email = os.getenv("ADMIN_EMAIL", "admin@example.com").lower()
    if not customers.find_one({"email": email}):
        customers.insert_one({"name": "Store Admin", "email": email, "phone": None, "role": "ADMIN", "status": "ACTIVE",
                              "passwordHash": bcrypt.hashpw(os.environ["ADMIN_PASSWORD"].encode(), bcrypt.gensalt()).decode(),
                              "createdAt": datetime.now(timezone.utc)})
        info("admin account created", email=email)


def consul_registration():
    """Self-registration in Consul, refreshed every 30 s."""
    consul = os.getenv("CONSUL_HTTP_ADDR", "http://consul:8500")
    address = os.getenv("POD_IP") or socket.gethostbyname(socket.gethostname())
    body = json.dumps({"ID": f"customer-service-{socket.gethostname()}", "Name": "customer-service", "Address": address,
                       "Port": PORT, "Tags": ["python"], "Meta": {"metrics_path": "/metrics"},
                       "Check": {"HTTP": f"http://{address}:{PORT}/health", "Interval": "10s", "Timeout": "3s",
                                 "DeregisterCriticalServiceAfter": "1m"}}).encode()
    while True:
        try:
            urllib.request.urlopen(urllib.request.Request(f"{consul}/v1/agent/service/register", data=body, method="PUT"), timeout=5)
        except Exception as error:
            log.warning("consul unavailable: %s", error)
        time.sleep(30)


@app.on_event("startup")
def startup():
    seed_admin()
    threading.Thread(target=consul_registration, daemon=True).start()
    info("customer-service started", port=PORT)


@app.on_event("shutdown")
def shutdown():
    consul = os.getenv("CONSUL_HTTP_ADDR", "http://consul:8500")
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"{consul}/v1/agent/service/deregister/customer-service-{socket.gethostname()}", method="PUT"), timeout=3)
    except Exception:
        pass
