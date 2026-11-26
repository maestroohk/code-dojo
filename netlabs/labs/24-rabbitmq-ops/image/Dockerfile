# The shop's services (a publisher and three workers) need an AMQP client. This adds the pika library
# (from Debian) to the shared lab tools image. Docker Compose builds it the first time the lab starts
# (it needs the internet once); after that the lab runs offline.
FROM dojo-toolbox:latest
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-pika \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -c "import pika; print('pika', pika.__version__)"
