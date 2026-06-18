import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

function buildSchemaForShape(shapeId: string, ast: any, schemas: Record<string, any>, xmlNamespace: string): any {
  const shapeName = shapeId.split('#')[1] || '';
  if (!shapeName) {
    return { type: 'string' };
  }

  if (schemas[shapeName]) {
    return { $ref: `#/components/schemas/${shapeName}` };
  }

  const shape = ast.shapes[shapeId];
  if (!shape) {
    return { type: 'string' };
  }

  const traits = shape.traits || {};
  const description = traits['smithy.api#documentation'];

  if (shape.type === 'structure') {
    const properties: Record<string, any> = {};
    const schemaObj: any = {
      type: 'object',
      properties
    };

    if (description) {
      schemaObj.description = description;
    }

    const xmlName = traits['smithy.api#xmlName'] || shapeName;
    schemaObj.xml = {
      name: xmlName,
      namespace: xmlNamespace
    };

    schemas[shapeName] = schemaObj;

    if (shape.members) {
      for (const [memberName, memberDef] of Object.entries<any>(shape.members)) {
        const mTraits = memberDef.traits || {};

        if (
          mTraits['smithy.api#httpHeader'] ||
          mTraits['smithy.api#httpLabel'] ||
          mTraits['smithy.api#httpQuery'] ||
          mTraits['smithy.api#httpResponseCode']
        ) {
          continue;
        }

        const targetId = memberDef.target;
        const targetShape = ast.shapes[targetId];

        let memberSchema: any;

        if (targetShape && targetShape.type === 'list') {
          const listMember = targetShape.member;
          const listMemberTarget = listMember.target;
          const listMemberTraits = listMember.traits || {};

          const itemSchema = buildSchemaForShape(listMemberTarget, ast, schemas, xmlNamespace);
          const itemXmlName = listMemberTraits['smithy.api#xmlName'];

          memberSchema = {
            type: 'array',
            items: itemSchema
          };

          if (mTraits['smithy.api#documentation']) {
            memberSchema.description = mTraits['smithy.api#documentation'];
          } else if (targetShape.traits?.['smithy.api#documentation']) {
            memberSchema.description = targetShape.traits['smithy.api#documentation'];
          }

          const wrapped = !mTraits['smithy.api#xmlFlattened'];
          memberSchema.xml = {
            name: mTraits['smithy.api#xmlName'] || memberName,
            wrapped
          };

          if (wrapped && itemXmlName && !itemSchema.$ref) {
            itemSchema.xml = itemSchema.xml || {};
            itemSchema.xml.name = itemXmlName;
          }
        } else {
          memberSchema = buildSchemaForShape(targetId, ast, schemas, xmlNamespace);
          if (mTraits['smithy.api#documentation']) {
            memberSchema.description = mTraits['smithy.api#documentation'];
          }
          const xmlName = mTraits['smithy.api#xmlName'];
          if (xmlName) {
            memberSchema.xml = memberSchema.xml || {};
            memberSchema.xml.name = xmlName;
          }
        }

        properties[memberName] = memberSchema;
      }
    }

    return { $ref: `#/components/schemas/${shapeName}` };
  }

  if (shape.type === 'list') {
    const listMember = shape.member;
    const listMemberTarget = listMember.target;
    const listMemberTraits = listMember.traits || {};

    const itemSchema = buildSchemaForShape(listMemberTarget, ast, schemas, xmlNamespace);
    const itemXmlName = listMemberTraits['smithy.api#xmlName'];
    if (itemXmlName && !itemSchema.$ref) {
      itemSchema.xml = itemSchema.xml || {};
      itemSchema.xml.name = itemXmlName;
    }

    const xmlName = traits['smithy.api#xmlName'] || shapeName;
    const wrapped = !traits['smithy.api#xmlFlattened'];

    return {
      type: 'array',
      items: itemSchema,
      xml: {
        name: xmlName,
        wrapped
      }
    };
  }

  let type = 'string';
  if (shape.type === 'integer' || shape.type === 'long') {
    type = 'integer';
  } else if (shape.type === 'boolean') {
    type = 'boolean';
  }

  const primSchema: any = { type };
  if (description) {
    primSchema.description = description;
  }
  return primSchema;
}

export async function compileCommand(opts: any) {
  const inputPath = opts.input || path.join(process.cwd(), 'specs', 'tier-1.smithy.bare.json');
  const outputSmithyPath = opts['output-smithy'] || path.join(process.cwd(), '../storage/tier-1.smithy.json');
  const outputOpenapiPath = opts['output-openapi'] || path.join(process.cwd(), '../storage/tier-1.openapi.yaml');
  const docsDir = opts.docs || path.join(process.cwd(), '../storage/operations');

  if (!existsSync(inputPath)) {
    throw new Error(`Smithy AST bare baseline not found at ${inputPath}. Run bootstrap first.`);
  }

  console.log(`Reading bare Smithy AST from ${inputPath}...`);
  let ast = JSON.parse(await fs.readFile(inputPath, 'utf-8'));

  const skipOverrides = docsDir === 'none' || docsDir === 'false';

  if (skipOverrides) {
    console.log('Skipping markdown documentation overrides (using documentation from input AST).');
  } else if (existsSync(docsDir)) {
    console.log(`Scanning and compiling from hybrid markdown files in ${docsDir}...`);
    const compiledAst: any = {
      smithy: "2.0",
      shapes: {}
    };

    function getHeaderSlug(headingText: string): string {
      // If the heading is of the form "Body: `type`" (primitive body), do not strip the type.
      const isPrimitiveBody = /^\s*(#{1,6}\s+)?body:\s+`[a-z]+`\s*$/i.test(headingText);
      const cleanHeading = isPrimitiveBody
        ? headingText
        : headingText.replace(/\s+`(string|integer|boolean|timestamp|blob|array|object)`(\s+required)?\s*$/i, '');
      return '#' + cleanHeading
        .toLowerCase()
        .replace(/[`:<>$\(\)\[\]]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    }

    async function parseAndResolveHybridFile(filePath: string): Promise<Record<string, any>> {
      let content = await fs.readFile(filePath, 'utf-8');
      
      // Translate GFM alert syntax to standard portable Markdown callouts
      content = content.replace(/^([ \t]*)>\s*\[!(NOTE|IMPORTANT|WARNING|TIP|CAUTION)\]/gim, (match, indent, type) => {
        const title = type.charAt(0) + type.slice(1).toLowerCase();
        return `${indent}> **${title}:**`;
      });
      const parts = content.split(/<details>/i);
      if (parts.length < 2) {
        throw new Error(`No <details> block found in hybrid file: ${filePath}`);
      }
      const detailsContent = parts.pop() || '';
      const jsonMatch = detailsContent.match(/```json\s*([\s\S]*?)\s*```/i);
      if (!jsonMatch) {
        throw new Error(`No JSON block found inside <details> in hybrid file: ${filePath}`);
      }
      let markdownPlane = parts.join('<details>').trim();
      // Strip navigation line if present (e.g. after the H1 header)
      markdownPlane = markdownPlane.replace(/\[Request\]\(#request\)\s*→\s*\[Response\]\(#response-\d+-success\)(?:\s*𝄁\s*\[Error\]\(#errors\))?[\r\n]*/gi, '');
      markdownPlane = markdownPlane.replace(/\s*##\s+Smithy\s+Spec\s*$/i, '').trim();
      if (markdownPlane.endsWith('---')) {
        markdownPlane = markdownPlane.slice(0, -3).trim();
      }
      const jsonText = (jsonMatch[1] || '').trim();
      const shapesObj = JSON.parse(jsonText);
      
      const sections: Record<string, string> = {};
      const lines = markdownPlane.split(/\r?\n/);
      let currentSlug = '';
      let currentContent: string[] = [];
      
      for (const line of lines) {
        const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headerMatch) {
          if (currentSlug) {
            sections[currentSlug] = currentContent.join('\n').trim();
          }
          const headingText = (headerMatch[2] || '').trim();
          currentSlug = getHeaderSlug(headingText);
          currentContent = [];
        } else {
          if (currentSlug) {
            currentContent.push(line);
          }
        }
      }
      if (currentSlug) {
        sections[currentSlug] = currentContent.join('\n').trim();
      }
      
      function resolveRefs(obj: any): any {
        if (obj === null || typeof obj !== 'object') {
          return obj;
        }
        if (obj.$ref && typeof obj.$ref === 'string' && obj.$ref.startsWith('#')) {
          const slug = obj.$ref;
          let docText = sections[slug];
          if (docText !== undefined) {
            // Strip presentation-only "Type: [Name](shared-shapes.md#schema-name)" suffixes
            docText = docText.replace(/\nType:\s+(?:Array of\s+|Map of\s+)?\[[^\]]+\]\(shared-shapes\.md#[^\)]+\)/g, '').trim();
            return docText;
          } else {
            console.warn(`Warning: Reference ${slug} in ${filePath} could not be resolved.`);
            return '';
          }
        }
        if (Array.isArray(obj)) {
          return obj.map(resolveRefs);
        }
        const resolved: any = {};
        for (const [k, v] of Object.entries(obj)) {
          resolved[k] = resolveRefs(v);
        }
        return resolved;
      }
      
      return resolveRefs(shapesObj.shapes || {});
    }

    // Load shared-shapes.md
    const sharedShapesPath = path.join(docsDir, 'shared-shapes.md');
    if (existsSync(sharedShapesPath)) {
      console.log(`Loading shared-shapes.md...`);
      const indexShapes = await parseAndResolveHybridFile(sharedShapesPath);
      Object.assign(compiledAst.shapes, indexShapes);
    } else {
      console.warn(`Warning: shared-shapes.md not found in ${docsDir}`);
    }

    const s3Service = ast.shapes['com.amazonaws.s3#AmazonS3'];
    const opNames = new Set(
      s3Service && s3Service.operations
        ? s3Service.operations.map((op: any) => op.target.split('#')[1])
        : []
    );

    // Load all operation markdown files
    const files = await fs.readdir(docsDir);
    for (const file of files) {
      if (file.endsWith('.md') && file !== 'index.md' && file !== 'shared-shapes.md') {
        const opName = file.slice(0, -3);
        if (!opNames.has(opName)) {
          continue;
        }
        const filePath = path.join(docsDir, file);
        console.log(`Loading ${file}...`);
        const opShapes = await parseAndResolveHybridFile(filePath);
        Object.assign(compiledAst.shapes, opShapes);
      }
    }

    ast = compiledAst;
  } else {
    console.warn(`Documentation overrides directory not found at ${docsDir}. Generating without custom docs.`);
  }

  const s3Service = ast.shapes['com.amazonaws.s3#AmazonS3'];
  if (!s3Service || !s3Service.operations) {
    throw new Error('S3 service shape not found in AST');
  }

  const xmlNamespace = s3Service.traits?.['smithy.api#xmlNamespace']?.uri || 'http://s3.amazonaws.com/doc/2006-03-01/';

  // Save documented Smithy AST JSON
  await fs.mkdir(path.dirname(outputSmithyPath), { recursive: true });
  await fs.writeFile(outputSmithyPath, JSON.stringify(ast, null, 2), 'utf-8');
  console.log(`Saved documented Smithy AST to ${outputSmithyPath}`);

  // Compile OpenAPI Spec from documented AST
  const openapi: any = {
    openapi: '3.1.0',
    info: {
      title: 'Cloud Portable Storage API',
      version: '1.0.0',
      description: 'A minimal, portable, S3-compatible object storage baseline API (Tier 1 Core).',
      license: {
        name: 'Apache 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0.html'
      }
    },
    security: [
      {
        SigV4: []
      }
    ],
    servers: [
      {
        url: 'http://localhost:8080',
        description: 'Local storage engine proxy'
      }
    ],
    paths: {},
    components: {
      securitySchemes: {
        SigV4: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'Signature Version 4 (SigV4) authentication.'
        }
      },
      responses: {
        '400Error': {
          description: 'Bad Request',
          content: {
            'application/xml': {
              schema: {
                $ref: '#/components/schemas/Error'
              }
            }
          }
        },
        '403Error': {
          description: 'Access Denied',
          content: {
            'application/xml': {
              schema: {
                $ref: '#/components/schemas/Error'
              }
            }
          }
        },
        '404Error': {
          description: 'Not Found',
          content: {
            'application/xml': {
              schema: {
                $ref: '#/components/schemas/Error'
              }
            }
          }
        }
      },
      schemas: {
        Error: {
          type: 'object',
          xml: {
            name: 'Error',
            namespace: xmlNamespace
          },
          properties: {
            Code: { type: 'string', description: 'The error code (e.g. NoSuchKey)' },
            Message: { type: 'string', description: 'The detailed error message' },
            Resource: { type: 'string', description: 'The S3 resource address' },
            RequestId: { type: 'string', description: 'The S3 request ID' }
          }
        }
      }
    }
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
    let uriPath = httpTrait.uri.split('?')[0];
    uriPath = uriPath.replace(/{([a-zA-Z0-9]+)\+}/g, '{$1}');

    const description = opShape.traits?.['smithy.api#documentation'] || `S3 ${opName} operation`;

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
            hasPayloadMembers = true;
          }
        }

        // Define request body if there are payload members or for specific PUT/POST operations
        if (hasPayloadMembers || method === 'put' || method === 'post') {
          let requestBodyDoc = '';
          if (inputShape && inputShape.members) {
            for (const memberDef of Object.values<any>(inputShape.members)) {
              if (memberDef.traits?.['smithy.api#httpPayload']) {
                requestBodyDoc = memberDef.traits['smithy.api#documentation'] || '';
                break;
              }
            }
          }
          if (!requestBodyDoc && inputShape) {
            requestBodyDoc = inputShape.traits?.['smithy.api#documentation'] || '';
          }
          if (!requestBodyDoc) {
            requestBodyDoc = opName === 'PutObject' ? 'Object data payload' : (opName === 'CopyObject' ? 'Empty request body (copy source is specified in header)' : `Request payload for ${opName}`);
          }

          if (opName === 'PutObject') {
            requestBody = {
              description: requestBodyDoc,
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
          } else if (opName === 'CopyObject') {
            requestBody = {
              description: requestBodyDoc,
              required: false,
              content: {
                'application/xml': {
                  schema: {
                    type: 'string',
                    maxLength: 0,
                    description: 'Empty body'
                  }
                }
              }
            };
          } else {
            requestBody = {
              description: requestBodyDoc,
              required: true,
              content: {
                'application/xml': {
                  schema: {
                    type: 'object',
                    description: requestBodyDoc
                  }
                }
              }
            };
          }
        }
      }
    }

    const successCode = httpTrait.code || (method === 'delete' ? 204 : 200);

    let responseBodyDoc = '';
    const outputRef = opShape.output?.target;
    if (outputRef) {
      const outputShape = ast.shapes[outputRef];
      if (outputShape && outputShape.members) {
        for (const memberDef of Object.values<any>(outputShape.members)) {
          if (memberDef.traits?.['smithy.api#httpPayload']) {
            responseBodyDoc = memberDef.traits['smithy.api#documentation'] || '';
            break;
          }
        }
      }
      if (!responseBodyDoc && outputShape) {
        responseBodyDoc = outputShape.traits?.['smithy.api#documentation'] || '';
      }
    }
    if (!responseBodyDoc) {
      responseBodyDoc = 'Successful response';
    }

    const responses: any = {
      [successCode]: {
        description: responseBodyDoc,
        headers: {}
      },
      '400': {
        $ref: '#/components/responses/400Error'
      },
      '403': {
        $ref: '#/components/responses/403Error'
      },
      '404': {
        $ref: '#/components/responses/404Error'
      }
    };

    // Bind correct XML schemas to operation response body
    if (successCode === 200) {
      if (opName === 'ListObjectsV2') {
        buildSchemaForShape('com.amazonaws.s3#ListObjectsV2Output', ast, openapi.components.schemas, xmlNamespace);
        responses['200'].content = {
          'application/xml': {
            schema: {
              $ref: '#/components/schemas/ListObjectsV2Output'
            }
          }
        };
      } else if (opName === 'ListBuckets') {
        buildSchemaForShape('com.amazonaws.s3#ListBucketsOutput', ast, openapi.components.schemas, xmlNamespace);
        responses['200'].content = {
          'application/xml': {
            schema: {
              $ref: '#/components/schemas/ListBucketsOutput'
            }
          }
        };
      } else if (opName === 'DeleteObjects') {
        buildSchemaForShape('com.amazonaws.s3#DeleteObjectsOutput', ast, openapi.components.schemas, xmlNamespace);
        responses['200'].content = {
          'application/xml': {
            schema: {
              $ref: '#/components/schemas/DeleteObjectsOutput'
            }
          }
        };
      } else if (opName === 'CopyObject') {
        buildSchemaForShape('com.amazonaws.s3#CopyObjectResult', ast, openapi.components.schemas, xmlNamespace);
        responses['200'].content = {
          'application/xml': {
            schema: {
              $ref: '#/components/schemas/CopyObjectResult'
            }
          }
        };
      } else if (opName === 'GetObject') {
        responses['200'].content = {
          'application/octet-stream': {
            schema: {
              type: 'string',
              format: 'binary'
            }
          }
        };
      }
    }

    // Add common response headers based on output shape
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

  // Sort paths hierarchically
  const pathSortWeight = (p: string): number => {
    if (p === '/') return 1;
    if (p === '/{Bucket}') return 2;
    if (p === '/{Bucket}/{Key}') return 3;
    return 4 + p.split('/').filter(Boolean).length;
  };

  const sortedPaths = Object.keys(pathMethodGroups).sort((a, b) => pathSortWeight(a) - pathSortWeight(b));

  for (const uriPath of sortedPaths) {
    const methods = pathMethodGroups[uriPath]!;
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
        // Prioritize common operations (like PutObject before CopyObject)
        const opPriority: Record<string, number> = {
          PutObject: 1,
          CopyObject: 2
        };
        ops.sort((a, b) => {
          const prioA = opPriority[a.opName] || 99;
          const prioB = opPriority[b.opName] || 99;
          if (prioA !== prioB) return prioA - prioB;
          return a.opName.localeCompare(b.opName);
        });

        // Generate a simplified merged name if all operations share the same suffix (e.g. "Object")
        let operationId = '';
        if (ops.length === 2 && ops[0].opName.endsWith('Object') && ops[1].opName.endsWith('Object')) {
          const prefix0 = ops[0].opName.slice(0, -6); // Strip 'Object'
          operationId = `${prefix0}Or${ops[1].opName}`; // e.g. PutOrCopyObject
        } else {
          operationId = ops.map(o => o.opName).join('Or');
        }
        console.log(`[COMPILE] Merging overlapping operations [${ops.map(o => o.opName).join(', ')}] at ${method.toUpperCase()} ${uriPath}`);

        let description = `This endpoint combines multiple S3 behaviors depending on the request parameters and headers:\n\n`;
        ops.forEach((o) => {
          description += `### ${o.opName}\n\n${o.description}\n\n---\n\n`;
        });
        if (description.endsWith('\n\n---\n\n')) {
          description = description.slice(0, -7);
        }

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
            if (responseVal.content) {
              responses[statusCode].content = responses[statusCode].content || {};
              for (const [contentType, contentVal] of Object.entries<any>(responseVal.content)) {
                responses[statusCode].content[contentType] = contentVal;
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

  const yamlContent = yaml.stringify(openapi);
  await fs.mkdir(path.dirname(outputOpenapiPath), { recursive: true });
  await fs.writeFile(outputOpenapiPath, yamlContent, 'utf-8');
  console.log(`[COMPILE] Generated OpenAPI 3.1 YAML spec at ${outputOpenapiPath}`);
}
