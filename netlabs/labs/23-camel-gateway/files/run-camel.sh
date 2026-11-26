# Entry point of the camel container: wait for the shared project folder, then run every
# route file in /work/camel/routes in dev mode (saving a file reloads the routes).
# If Camel ever stops, it starts again after two seconds (camel-restart uses this).
until [ -f /work/.seeded ]; do sleep 0.3; done
cd /work/camel
printf '%s\n' "cd /work/camel" "echo 'Camel runs here. Try: camel get route   camel get health   tail -f /work/logs/camel.log'" >> ~/.bashrc
while true; do
  echo "=== $(date '+%F %T') starting Camel" >> /work/logs/camel.log
  camel run --source-dir=/work/camel/routes --name=orders --dev --port=8080 --download=false \
    --logging-category=org.apache.camel.dsl.yaml.common.YamlDeserializerBase=error \
    >> /work/logs/camel.log 2>&1
  echo "=== $(date '+%F %T') Camel stopped, starting again in 2 seconds" >> /work/logs/camel.log
  sleep 2
done