# Lesson 3: a launch configuration that never hits a breakpoint: it points at a file that does not exist.
. "$DOJO_FILES/lib.sh"
make_repo ~/shop
mkdir -p .vscode
cat > .vscode/launch.json <<'EOF'
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run the service",
      "type": "debugpy",
      "request": "launch",
      "program": "${workspaceFolder}/app.py",
      "console": "integratedTerminal"
    }
  ]
}
EOF
