# Shared by the project's scenarios: put the TodoApi repository in ~/todo, with the clutter a real checkout has
# (build output, IDE folders, Git, tests, docs, a local secrets file). Sourced after lib.sh.
mkdir -p ~/todo
cp "$DOJO_FILES/todo/TodoApi.csproj" "$DOJO_FILES/todo/Program.cs" "$DOJO_FILES/todo/appsettings.json" ~/todo/
cd ~/todo
mkdir -p bin/Debug/net10.0 obj .vs .git/objects tests/TodoApi.Tests/bin/Debug docs
head -c 3000000 /dev/zero > bin/Debug/net10.0/TodoApi.dll
echo '{}' > obj/project.assets.json
echo 'ref: refs/heads/main' > .git/HEAD
echo '{"ConnectionStrings":{"Todo":"Host=localhost;Password=dev-only-example"}}' > appsettings.Development.json
echo '{ "DB_PASSWORD": "dev-only-example" }' > secrets.local.json
echo '// tests' > tests/TodoApi.Tests/TodoTests.cs
head -c 1000000 /dev/zero > tests/TodoApi.Tests/bin/Debug/TodoApi.Tests.dll
printf '%s\n' '# TodoApi' 'A minimal ASP.NET Core 10 API: GET /health, GET /health/ready, GET/POST /todos.' > README.md
echo '# Architecture notes' > docs/architecture.md
cd ~
