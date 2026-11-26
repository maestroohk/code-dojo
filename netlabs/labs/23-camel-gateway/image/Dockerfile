# Camel JBang with every jar this lab needs already downloaded, so the lab runs offline.
# Docker Compose builds it the first time the lab starts (it needs the internet once).
FROM apache/camel-jbang:4.22.1
COPY --chown=ubuntu:ubuntu image/warm /home/ubuntu/warm
# Run a solved copy of the routes for a few seconds: Camel downloads each component it uses.
RUN cd /home/ubuntu/warm \
 && (timeout 180 camel run --source-dir=/home/ubuntu/warm --port=8080 --max-seconds=15 || true) \
 && ls /home/ubuntu/.m2/repository/org/apache/camel/camel-jq /home/ubuntu/.m2/repository/org/apache/camel/camel-platform-http-vertx \
 && rm -rf /home/ubuntu/warm /tmp/warm /home/ubuntu/.camel/*.pid
WORKDIR /home/ubuntu
