# Shared helpers for this module's scenarios (sourced by the other scripts here).
set -e -o pipefail
mkdir -p /opt/dojo/state

# A small Python service, the kind of repo the lessons set VS Code up for.
make_repo() {   # make_repo DIR
  rm -rf "$1"; mkdir -p "$1/src" "$1/tests"; cd "$1"
  git init -q -b main
  cat > src/app.py <<'EOF'
import argparse, os

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8000)
    a = p.parse_args()
    env = os.environ.get("APP_ENV", "prod")
    print(f"listening on {a.port} in {env}")

if __name__ == "__main__":
    main()
EOF
  printf '%s\n' 'flask==3.1.0' > requirements.txt
  printf '%s\n' '# shop' 'Run: python src/app.py --port 8000' > README.md
  git add -A
  GIT_AUTHOR_DATE='@1764100000 +0000' GIT_COMMITTER_DATE='@1764100000 +0000' git commit -q -m "Initial service"
}
