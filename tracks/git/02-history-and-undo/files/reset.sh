# Lesson 3: two repos. ~/api has three messy WIP commits (and a secret staged by mistake);
# ~/spike holds an experiment that should vanish completely.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/api
write src/server.py "from http.server import HTTPServer"
commit "Initial API"
write src/limits.py "MAX_REQUESTS = 100"
commit "Add rate limiter"
write src/logging_mw.py "def log(request):" "    pass"
commit "WIP"
write src/logging_mw.py "def log(request):" "    print(request.path)"
commit "WIP 2"
write src/logging_mw.py "def log(request):" "    print(request.method, request.path)" "" "def install(app):" "    app.middleware.append(log)"
commit "more WIP"
note wip-tip "$(git rev-parse HEAD)"
write secrets.env "STRIPE_KEY=sk_test_not_for_git"
git add secrets.env

fresh_repo ~/spike
write app.py "print('stable')"
commit "Stable version"
note spike-base "$(git rev-parse HEAD)"
write app.py "import orjson" "print('fast?')"
commit "Try orjson"
write app.py "import orjson, ujson" "print('faster?')"
commit "Try ujson as well"
write app.py "import orjson, ujson, simdjson" "print('this is getting silly')"
