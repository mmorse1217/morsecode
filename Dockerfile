FROM ubuntu:latest

ARG HUGO_VERSION=0.164.0
ARG TARGETARCH

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        curl \
        golang-go \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --silent --show-error \
        --output /tmp/hugo.tar.gz \
        "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${TARGETARCH}.tar.gz" \
    && tar --extract --gzip --file /tmp/hugo.tar.gz --directory /usr/local/bin hugo \
    && rm /tmp/hugo.tar.gz

WORKDIR /src

ENTRYPOINT ["hugo"]
CMD ["--help"]
