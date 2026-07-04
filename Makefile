.PHONY: start

start:
	@echo "Starting JARVIS..."
	@trap 'kill 0' EXIT; \
	node jarvis-server.mjs & \
	if [ -d freellmapi ]; then (cd freellmapi && npm run dev) & else echo "FreeLLMAPI not found; skipping optional proxy."; fi; \
	(cd jarvis-ui && npm run dev) & \
	wait
