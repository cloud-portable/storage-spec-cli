# Storage Spec CLI

`storage-spec` is a Node.js CLI tool designed to generate reproducible, native Smithy AST profiles summarizing the compatibility level of generic S3-compatible storage implementations. 

## Smithy vs. OpenAPI Specifications

This project works with two separate representations of the specification because they serve different purposes:

*   **Smithy AST JSON (`rfc-storage-tier-1.smithy.json`)**:
    *   *The Source of Truth*: Smithy is AWS's modern IDL (Interface Definition Language) designed specifically to model complex, protocol-heavy service APIs.
    *   *Why we use it*: S3 is not a standard REST API. It routes different operations (like `CopyObject` and `PutObject`) to the exact same HTTP path and method via query parameters and headers, and relies on strict SigV4 cryptographic signature traits. Smithy models these AWS-specific traits, protocol choices, and structures perfectly.
    *   *Primary Uses*: Service proxies, S3 client routing engines, and compliance capture tests.
*   **OpenAPI 3.1 YAML (`rfc-storage-tier-1.openapi.yaml`)**:
    *   *Developer-Friendly View*: A standard REST API representation of the subset.
    *   *Why we generate it*: The standard REST tooling ecosystem is built around OpenAPI. By compiling our Smithy spec to OpenAPI, we enable developers to use standard API tools (such as Swagger, Redocly, and Postman), generate client libraries, and spin up mock servers out-of-the-box.
    *   *Overlapping HTTP Semantics*: Because multiple S3 operations map to the same HTTP path and method (e.g. `PUT /{Bucket}/{Key}` handles both object uploads and server-side copying), the generator merges these behaviors into single, clean, combined OpenAPI paths with descriptive, flat markdown documentation explaining the different request headers required for each behavior.

## Installation

### Local Development (Pre-publish)
If you are developing locally with this and the `storage` specifications repository side-by-side, you can link the binary globally:
```bash
# In the storage-spec-cli directory:
npm install
npm run build
npm link
```
This registers the global `storage-spec` command on your machine. You can then run it from any directory (including the `storage` sibling repo) using `storage-spec <command>`.

### Once Published (Public Registry)
Once published, you can execute it directly from the registry:
```bash
npx @cloud-portable/storage-spec <command>
```

## Usage

Below, we assume the command `storage-spec` has been linked locally. (If running from the registry, prefix commands with `npx @cloud-portable/storage-spec`).

### 1. `init`
Downloads and caches the official canonical S3 Smithy Model (`s3-2006-03-01.json`). It reads a tiers markdown file (defaults to `s3-baseline.md`, or a custom path via `--source`) to identify the core capabilities an S3-compatible service is expected to support, generating a stripped baseline model.
```bash
# Initialize using the default baseline
storage-spec init

# Initialize using a custom tiers definition (e.g. from the storage repository)
storage-spec init --source ../storage/tiers.md
```
*Outputs: `specs/s3-baseline.json`*

### 2. `capture`
Starts a programmable intercepting proxy that forwards traffic to your specified target HTTP API. Provides a hermetic way to test exact operation support. 
```bash
storage-spec capture --target http://localhost:9000 -- <your-test-command>
# e.g. storage-spec capture --target http://localhost:9000 -- pytest s3-tests/
```
The test command is executed. The proxy observes the passing traffic, maps the wire operations back to Smithy, and synthesizes the subset of supported operations into a target Smithy AST profile.

*Outputs: `specs/compatible-s3.json`*

### 3. `diff`
Performs an operation-level comparison between the generated compatibility profile and the canonical baseline. Generates a clear Markdown report demonstrating coverage percentages and specific unimplemented operations.
```bash
storage-spec diff --output Report.md
```

### 4. `openapi`
Generates a standard OpenAPI 3.1 YAML specification from a Smithy AST JSON profile. It automatically handles HTTP operation overlapping by merging operations sharing path and method (such as `CopyObject` and `PutObject` on `PUT /{Bucket}/{Key}`) into clean, multi-behavior endpoints.
```bash
storage-spec openapi --input specs/s3-baseline.json --output specs/openapi.yaml
```
*Outputs: `specs/openapi.yaml`*

