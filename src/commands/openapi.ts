import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Helper to serialize JS object to YAML
function serializeYamlValue(val: any, indent = 0): string {
  const spaces = ' '.repeat(indent);
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    if (val.includes('\n')) {
      return `|\n${val.split('\n').map(line => spaces + '  ' + line).join('\n')}`;
    }
    if (val.match(/[:#\[\]\{\},&*!|>'"`]/) || val.trim() !== val || val === '') {
      return `"${val.replace(/"/g, '\\"')}"`;
    }
    return val;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    return '\n' + val.map(item => `${spaces}- ${serializeYamlValue(item, indent + 2)}`).join('\n');
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    return '\n' + keys.map(key => {
      const escapedKey = key.match(/[:#\[\]\{\},&*!|>'"`\s]/) ? `"${key.replace(/"/g, '\\"')}"` : key;
      return `${spaces}${escapedKey}: ${serializeYamlValue(val[key], indent + 2)}`;
    }).join('\n');
  }
  return String(val);
}

function toYaml(obj: any): string {
  return Object.keys(obj).map(key => {
    const escapedKey = key.match(/[:#\[\]\{\},&*!|>'"`\s]/) ? `"${key.replace(/"/g, '\\"')}"` : key;
    return `${escapedKey}: ${serializeYamlValue(obj[key], 2)}`;
  }).join('\n') + '\n';
}

export async function openapiCommand(opts: any) {
  const specsDir = path.join(process.cwd(), 'specs');
  const inputPath = opts.input || path.join(specsDir, 's3-baseline.json');
  const outputPath = opts.output || path.join(specsDir, 'openapi.yaml');

  if (!existsSync(inputPath)) {
    throw new Error(`Smithy AST baseline not found at ${inputPath}. Run init first.`);
  }

  console.log(`Reading Smithy AST from ${inputPath}...`);
  const ast = JSON.parse(await fs.readFile(inputPath, 'utf-8'));

  const s3Service = ast.shapes['com.amazonaws.s3#AmazonS3'];
  if (!s3Service || !s3Service.operations) {
    throw new Error('S3 service shape not found in AST');
  }

  const openapi: any = {
    openapi: '3.1.0',
    info: {
      title: 'Cloud Portable Storage API',
      version: '1.0.0',
      description: 'A minimal, portable, S3-compatible object storage baseline API (Tier 1 Core).'
    },
    paths: {}
  };

  const parsedOps: any[] = [];

  for (const opRef of s3Service.operations) {
    const opId = opRef.target;
    const opShape = ast.shapes[opId];
    if (!opShape || opShape.type !== 'operation') continue;

    const httpTrait = opShape.traits?.['smithy.api#http'];
    if (!httpTrait) continue;

    const opName = opId.split('#')[1];
    const method = httpTrait.method.toLowerCase();
    
    // Normalize S3 URI paths
    // 1. Strip query strings from path (e.g. /{Bucket}?delete -> /{Bucket})
    // 2. Normalize key placeholders (e.g. /{Key+} -> /{Key})
    let uriPath = httpTrait.uri.split('?')[0];
    uriPath = uriPath.replace(/{([a-zA-Z0-9]+)\+}/g, '{$1}');

    const docTrait = opShape.traits?.['smithy.api#documentation'];
    const description = docTrait || `S3 ${opName} operation`;

    // Process parameters from input structure
    const parameters: any[] = [];
    let requestBody: any = null;

    const inputRef = opShape.input?.target;
    if (inputRef) {
      const inputShape = ast.shapes[inputRef];
      if (inputShape && inputShape.members) {
        let hasPayloadMembers = false;
        
        for (const [memberName, memberDef] of Object.entries<any>(inputShape.members)) {
          const traits = memberDef.traits || {};
          const isRequired = !!traits['smithy.api#required'];
          const paramDoc = traits['smithy.api#documentation'] || '';

          // Determine schema type
          const targetShape = ast.shapes[memberDef.target];
          const type = targetShape ? (targetShape.type === 'integer' ? 'integer' : (targetShape.type === 'boolean' ? 'boolean' : 'string')) : 'string';

          if (traits['smithy.api#httpLabel']) {
            parameters.push({
              name: memberName,
              in: 'path',
              required: true,
              description: paramDoc,
              schema: { type }
            });
          } else if (traits['smithy.api#httpQuery']) {
            parameters.push({
              name: traits['smithy.api#httpQuery'],
              in: 'query',
              required: isRequired,
              description: paramDoc,
              schema: { type }
            });
          } else if (traits['smithy.api#httpHeader']) {
            parameters.push({
              name: traits['smithy.api#httpHeader'],
              in: 'header',
              required: isRequired,
              description: paramDoc,
              schema: { type }
            });
          } else {
            // Member belongs to payload/body
            hasPayloadMembers = true;
          }
        }

        // Define request body if there are payload members or for specific PUT/POST operations
        if (hasPayloadMembers || method === 'put' || method === 'post') {
          if (opName === 'PutObject') {
            requestBody = {
              description: 'Object data payload',
              required: true,
              content: {
                'application/octet-stream': {
                  schema: {
                    type: 'string',
                    format: 'binary'
                  }
                }
              }
            };
          } else {
            requestBody = {
              description: `Request payload for ${opName}`,
              required: true,
              content: {
                'application/xml': {
                  schema: {
                    type: 'object',
                    description: `XML structure for ${opName}`
                  }
                }
              }
            };
          }
        }
      }
    }

    const successCode = httpTrait.code || (method === 'delete' ? 204 : 200);

    const responses: any = {
      [successCode]: {
        description: 'Successful response',
        headers: {}
      }
    };

    // Add common response headers based on output shape
    const outputRef = opShape.output?.target;
    if (outputRef) {
      const outputShape = ast.shapes[outputRef];
      if (outputShape && outputShape.members) {
        for (const [memberName, memberDef] of Object.entries<any>(outputShape.members)) {
          const traits = memberDef.traits || {};
          if (traits['smithy.api#httpHeader']) {
            const headerName = traits['smithy.api#httpHeader'];
            responses[successCode].headers[headerName] = {
              description: traits['smithy.api#documentation'] || '',
              schema: { type: 'string' }
            };
          }
        }
      }
    }

    parsedOps.push({
      opName,
      method,
      uriPath,
      description,
      parameters,
      requestBody,
      responses
    });
  }

  // Group operations by path and method to handle overlaps cleanly
  const pathMethodGroups: Record<string, Record<string, any[]>> = {};

  for (const op of parsedOps) {
    let methodGroup = pathMethodGroups[op.uriPath];
    if (!methodGroup) {
      methodGroup = {};
      pathMethodGroups[op.uriPath] = methodGroup;
    }
    let opsList = methodGroup[op.method];
    if (!opsList) {
      opsList = [];
      methodGroup[op.method] = opsList;
    }
    opsList.push(op);
  }

  // Build the unified path list
  for (const [uriPath, methods] of Object.entries(pathMethodGroups)) {
    openapi.paths[uriPath] = {};
    for (const [method, ops] of Object.entries(methods)) {
      if (ops.length === 1) {
        const op = ops[0]!;
        openapi.paths[uriPath][method] = {
          operationId: op.opName,
          summary: op.opName,
          description: op.description,
          parameters: op.parameters,
          ...(op.requestBody ? { requestBody: op.requestBody } : {}),
          responses: op.responses
        };
      } else {
        // Sort operations by name to ensure deterministic order (e.g. CopyObject before PutObject)
        ops.sort((a, b) => a.opName.localeCompare(b.opName));
        
        const operationId = ops.map(o => o.opName).join('Or');
        console.log(`[OPENAPI] Merging overlapping operations [${ops.map(o => o.opName).join(', ')}] at ${method.toUpperCase()} ${uriPath}`);

        // Build a single, clean markdown description showing all behaviors
        let description = `This endpoint combines multiple S3 behaviors depending on the request parameters and headers:\n\n`;
        ops.forEach((o) => {
          description += `### ${o.opName}\n\n${o.description}\n\n---\n\n`;
        });
        // Strip the trailing separator
        if (description.endsWith('\n\n---\n\n')) {
          description = description.slice(0, -7);
        }

        // Combine query / header parameters, ensuring uniqueness by name & location
        const parameters: any[] = [];
        const seenParams = new Set<string>();
        for (const op of ops) {
          for (const param of op.parameters) {
            const paramKey = `${param.name}:${param.in}`;
            if (!seenParams.has(paramKey)) {
              seenParams.add(paramKey);
              parameters.push(param);
            }
          }
        }

        // Combine request bodies
        let requestBody: any = null;
        const requestBodyDescriptions: string[] = [];
        const contentTypes: Record<string, any> = {};

        for (const op of ops) {
          if (op.requestBody) {
            requestBodyDescriptions.push(`**${op.opName}**: ${op.requestBody.description}`);
            if (op.requestBody.content) {
              for (const [contentType, contentVal] of Object.entries<any>(op.requestBody.content)) {
                contentTypes[contentType] = contentVal;
              }
            }
          }
        }

        if (requestBodyDescriptions.length > 0) {
          requestBody = {
            description: `Request payload format varies depending on the operation:\n` + requestBodyDescriptions.map(d => `- ${d}`).join('\n'),
            required: true,
            content: contentTypes
          };
        }

        // Combine responses
        const responses: Record<string, any> = {};
        for (const op of ops) {
          for (const [statusCode, responseVal] of Object.entries<any>(op.responses)) {
            if (!responses[statusCode]) {
              responses[statusCode] = {
                description: responseVal.description || 'Successful response',
                headers: {}
              };
            }
            if (responseVal.headers) {
              for (const [headerName, headerVal] of Object.entries<any>(responseVal.headers)) {
                responses[statusCode].headers[headerName] = headerVal;
              }
            }
          }
        }

        openapi.paths[uriPath][method] = {
          operationId,
          summary: operationId,
          description,
          parameters,
          ...(requestBody ? { requestBody } : {}),
          responses
        };
      }
    }
  }

  const yamlContent = toYaml(openapi);
  await fs.writeFile(outputPath, yamlContent, 'utf-8');
  console.log(`[OPENAPI] Generated OpenAPI 3.1 YAML at ${outputPath}`);
}
