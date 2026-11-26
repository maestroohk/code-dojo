# Lesson 4: a fresh .NET repo with build output, logs and a local secrets file lying around.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/api
write src/Program.cs "Console.WriteLine(\"hi\");"
write src/Api.csproj "<Project Sdk=\"Microsoft.NET.Sdk.Web\" />"
commit "Start the API"
write src/bin/Debug/net10.0/Api.dll "binary"
write src/obj/project.assets.json "{}"
write app.log "started"
write logs/errors.log "boom"
write logs/keep.log "This log is a test fixture the team keeps in the repo."
write .env "DB_PASSWORD=hunter2"
