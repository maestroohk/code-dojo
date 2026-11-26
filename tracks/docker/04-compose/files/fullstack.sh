# Lesson 4: a full stack written in a hurry: three bugs that each look fine in review.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/shop
cat > ~/shop/compose.yaml <<'EOF'
services:
  web:
    image: shop/web:1.0
    ports:
      - "80:8080"
    networks: [front]
    depends_on: [api]

  api:
    image: shop/api:1.1
    environment:
      DB_HOST: localhost
    networks: [front, back]
    depends_on:
      db:
        condition: service_healthy
    restart: on-failure:3

  db:
    image: shop/db:17
    volumes:
      - dbdata:/data
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/ready"]
      interval: 1s
      retries: 20
    networks: [back]

volumes:
  dbdata:

networks:
  front:
  back:
EOF
