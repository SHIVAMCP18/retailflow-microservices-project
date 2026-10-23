FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /billing .

FROM alpine:3.20
RUN adduser -D -u 10001 app && mkdir /data && chown app /data
COPY --from=build /billing /usr/local/bin/billing
USER 10001
EXPOSE 8084
CMD ["billing"]
