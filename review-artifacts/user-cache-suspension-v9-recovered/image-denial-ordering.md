# Attached-image denial ordering

Image permission responses use a durable per-user, per-parent, per-image
resource order in the existing offline-cache metadata store. Starting an
authorized image read reserves the next order. A `401`, `403`, or `404`
advances that order and records an image-only denial only when the response
still owns the order it started with.

An older response therefore cannot overwrite a newer denial, including when a
tab missed the denial broadcast. A successful newer authorized response may
replace the denial, but its metadata transaction checks the same durable order
before publishing the new file reference. The denial does not suspend the user,
remove the note body, or invalidate unrelated images.

Preview invalidation carries the referenced parent and image ID. It revokes and
removes only that displayed blob URL; full user invalidation continues to use
the existing purge lifecycle.
