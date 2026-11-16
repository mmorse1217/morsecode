IMAGE ?= local-hugo
DOCKER_RUN ?= docker run --rm --init --user $(shell id -u):$(shell id -g) --volume "$(CURDIR):/src" --workdir /src --env HUGO_CACHEDIR=/tmp/hugo-cache
CONTAINER ?= $(DOCKER_RUN) $(IMAGE)
SERVER_CONTAINER ?= $(DOCKER_RUN) --publish 1313:1313 $(IMAGE)

.PHONY: image init build serve hugo

image:
	docker build --tag $(IMAGE) .

# Create a new Hugo site in this directory. Existing non-Hugo files are retained.
init: image
	$(CONTAINER) new site . --force

build: image
	$(CONTAINER) --destination public --gc --minify

serve: image
	$(SERVER_CONTAINER) server --bind 0.0.0.0 --baseURL http://localhost:1313 --disableFastRender

# Example: make hugo ARGS='new content posts/my-post.md'
hugo: image
	$(CONTAINER) $(ARGS)
