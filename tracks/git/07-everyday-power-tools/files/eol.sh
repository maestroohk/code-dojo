# Lesson 5: a Windows teammate committed the deploy script with CRLF line endings.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/ops
printf '#!/bin/bash\r\necho "deploying $1"\r\n' > deploy.sh
chmod +x deploy.sh
printf 'name: ops\r\nreplicas: 2\r\n' > app.yaml
write README.md "# Ops"
commit "Add the deploy script" "Ana Silva"