#!/bin/sh
# Registers the website in Consul (every 30 s) so Kong can route "/" to it,
# exactly like the five business services register themselves.
CONSUL="${CONSUL_HTTP_ADDR:-http://consul:8500}"
ADDR="${POD_IP:-$(hostname -i | awk '{print $1}')}"
ID="web-ui-$(hostname)"
BODY="{\"ID\":\"$ID\",\"Name\":\"web-ui\",\"Address\":\"$ADDR\",\"Port\":8080,\"Tags\":[\"react\"],\"Check\":{\"HTTP\":\"http://$ADDR:8080/health\",\"Interval\":\"10s\",\"DeregisterCriticalServiceAfter\":\"1m\"}}"
while true; do
  curl -s -o /dev/null -X PUT -d "$BODY" "$CONSUL/v1/agent/service/register" || echo "consul unavailable, retrying"
  sleep 30
done
