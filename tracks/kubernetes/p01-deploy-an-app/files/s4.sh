# Stage 4: the API runs with no probes and no resources: production would not accept it.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/stages.sh"
stage_deployment
stage_db
stage_services
wait_all
