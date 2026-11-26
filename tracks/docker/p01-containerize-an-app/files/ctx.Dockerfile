# Used by a check: copies the whole build context into an image, so the check can list what the builder received.
FROM busybox:1.37
COPY . /ctx
