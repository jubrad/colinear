# The colinear operator. Build from deploy/:
#   docker build -f images/operator.Dockerfile -t coli-operator .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p coli-operator

# no shell, no package manager, not root: it only talks to the Kubernetes API
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/coli-operator /coli-operator
USER nonroot
ENTRYPOINT ["/coli-operator"]
