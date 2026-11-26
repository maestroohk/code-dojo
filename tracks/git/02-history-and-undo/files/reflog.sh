# Lesson 5: three commits "lost" to a reset --hard, and unfinished ideas in the working tree.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/blog
write index.md "# Blog"
write drafts/ideas.md "# Ideas" "- a post about Git"
commit "Start the blog"
write posts/hello.md "# Hello" "First post."
commit "First post"
write posts/caching.md "# Caching" "Draft."
commit "Draft post on caching"
write posts/caching.md "# Caching" "Draft." "![diagram](img/cache.png)"
commit "Add images"
write posts/caching.md "# Caching" "Draft." "![diagram](img/cache.png)" "See [the docs](https://example.com/docs)."
commit "Fix links"
note lost-tip "$(git rev-parse HEAD)"
git reset -q --hard HEAD~3
write drafts/ideas.md "# Ideas" "- a post about Git" "- Post idea: why caches lie"
