#!/bin/sh
# nginx entrypoint hook: start the Consul registration loop in the background.
/register.sh &
