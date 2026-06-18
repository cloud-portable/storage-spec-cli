import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import TurndownService from 'turndown';

// AWS documentation sanitization rules
export function sanitizeDocumentation(text: any): string {
  if (!text || typeof text !== 'string') return '';

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
  });

  // Override escape to prevent escaping underscores (which S3 uses heavily in identifiers)
  turndownService.escape = function (string) {
    return string
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/`/g, '\\`')
      .replace(/#/g, '\\#')
      .replace(/(?<=^|\n)([0-9]+)\. /g, '$1\\. ')
      .replace(/!/g, '\\!')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/</g, '\\<')
      .replace(/>/g, '\\>');
  };

  // Custom rule for placeholder styling inside code tags
  turndownService.addRule('placeholderRule', {
    filter: ['i', 'em'],
    replacement: function (content, node) {
      let parent = node.parentNode;
      while (parent) {
        if (parent.nodeName.toLowerCase() === 'code') {
          return `<${content}>`;
        }
        parent = parent.parentNode;
      }
      return `*${content}*`;
    }
  });

  // Custom rule for <note> and <important> blocks
  turndownService.addRule('noteAndImportant', {
    filter: (node) => node.nodeName.toLowerCase() === 'note' || node.nodeName.toLowerCase() === 'important',
    replacement: function (content, node) {
      const type = node.nodeName.toLowerCase();
      const prefix = type === 'important' ? '**Important:**' : '**Note:**';
      const lines = content.trim().split('\n').map(line => line.trim());
      const cleanLines = [];
      for (const line of lines) {
        if (line !== '' || cleanLines[cleanLines.length - 1] !== '') {
          cleanLines.push(line);
        }
      }
      return `\n\n> ${prefix}\n> ` + cleanLines.join('\n> ') + '\n\n';
    }
  });

  // Custom rule for <dt> and <dd> definitions
  turndownService.addRule('dtRule', {
    filter: 'dt',
    replacement: function (content) {
      return `\n**${content.trim()}**:\n`;
    }
  });
  turndownService.addRule('ddRule', {
    filter: 'dd',
    replacement: function (content) {
      return `${content.trim()}\n`;
    }
  });


  // Custom rule for inline code (<code>) to trim content
  turndownService.addRule('codeRule', {
    filter: 'code',
    replacement: function (content) {
      return '`' + content.trim() + '`';
    }
  });

  // Custom rule for paragraphs (<p>) to avoid splitting nested list items
  turndownService.addRule('paragraphRule', {
    filter: 'p',
    replacement: function (content, node) {
      const parent = node.parentNode;
      if (parent && parent.nodeName.toLowerCase() === 'li') {
        let isFirst = true;
        let sibling = node.previousSibling;
        while (sibling) {
          if (sibling.nodeType === 1) {
            isFirst = false;
            break;
          }
          sibling = sibling.previousSibling;
        }
        return isFirst ? content : '\n\n' + content;
      }
      return '\n\n' + content + '\n\n';
    }
  });

  let clean = turndownService.turndown(text);

  // Post-process to fix minor Turndown quirks
  // 1. Remove space between closing backtick and trailing punctuation (e.g. `code` . -> `code`.)
  clean = clean.replace(/`\s+([\.,;\?!:])/g, '`$1');
  
  // 2. Unescape harmless backslash-escaped characters (like \- and \*) to keep markdown clean
  clean = clean.replace(/\\-/g, '-');
  clean = clean.replace(/\\\*/g, '*');

  // Clean up redundant empty lines (three or more newlines to two)
  clean = clean.replace(/\n{3,}/g, '\n\n').trim();

  return clean;
}

export function convertToGfmAlerts(content: string): string {
  return content.replace(/^([ \t]*)>\s*\*\*(Note|Important|Warning|Tip|Caution):\*\*/gim, (match, indent, type) => {
    return `${indent}> [!${type.toUpperCase()}]`;
  });
}

export function getShortDescription(text: string): string {
  if (!text || typeof text !== 'string') return '';
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>') || trimmed === '') {
      continue;
    }
    const match = trimmed.match(/^[^.!?]+[.!?]/);
    return (match ? match[0] : trimmed).trim();
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      return trimmed;
    }
  }
  return '';
}


export async function bootstrapCommand(options: any) {
  const modelUrl = 'https://raw.githubusercontent.com/aws/api-models-aws/main/models/s3/service/2006-03-01/s3-2006-03-01.json';
  const specsDir = path.join(process.cwd(), 'specs');
  const cachePath = path.join(specsDir, '.cache.json');
  const rawModelPath = path.join(specsDir, 's3-2006-03-01.json');
  
  const baselineModelPath = options.output ? path.resolve(process.cwd(), options.output) : path.join(specsDir, 'tier-1.smithy.bare.json');
  const sourcePath = options.source ? path.resolve(process.cwd(), options.source) : path.join(process.cwd(), '../storage/tier-1.yaml');
  const extractDocsDir = options['extract-docs'] ? path.resolve(process.cwd(), options['extract-docs']) : null;

  await fs.mkdir(path.dirname(baselineModelPath), { recursive: true });
  await fs.mkdir(specsDir, { recursive: true });

  let etag = '';
  if (existsSync(cachePath)) {
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    etag = cache.etag || '';
  }

  console.log('Fetching raw AWS Smithy model...');
  const headers = new Headers();
  if (etag) headers.set('If-None-Match', etag);

  try {
    const response = await fetch(modelUrl, { headers });

    if (response.status === 304) {
      console.log('Model unchanged (304 Not Modified). Using cached model.');
    } else if (!response.ok) {
      console.warn(`Failed to fetch model: ${response.statusText}. Attempting to use local cache...`);
      if (!existsSync(rawModelPath)) {
        throw new Error(`Local raw model cache not found at ${rawModelPath}`);
      }
    } else {
      console.log('Downloaded new raw S3 model. Saving...');
      const data = await response.text();
      await fs.writeFile(rawModelPath, data);
      
      const newEtag = response.headers.get('etag');
      if (newEtag) {
        await fs.writeFile(cachePath, JSON.stringify({ etag: newEtag }));
      }
    }
  } catch (error: any) {
    console.warn(`Network error fetching model: ${error.message}. Attempting to use local cache...`);
    if (!existsSync(rawModelPath)) {
      throw new Error(`Local raw model cache not found at ${rawModelPath}`);
    }
  }

  console.log(`Reading source tier manifest at ${sourcePath}...`);
  if (!existsSync(sourcePath)) {
    throw new Error(`Source tier manifest file not found at ${sourcePath}`);
  }
  const sourceContent = await fs.readFile(sourcePath, 'utf-8');
  const parsedYaml = yaml.parse(sourceContent);
  
  if (!parsedYaml || !Array.isArray(parsedYaml.operations)) {
    throw new Error(`Invalid tier manifest. Missing 'operations' array in ${sourcePath}`);
  }

  const requiredOperations = new Set<string>(
    parsedYaml.operations.map((op: any) => {
      if (typeof op === 'string') return op;
      if (op && typeof op === 'object' && op.name) return op.name;
      throw new Error(`Invalid operation item in tier manifest: ${JSON.stringify(op)}`);
    })
  );

  console.log(`Parsed ${requiredOperations.size} operations from manifest.`);

  console.log('Parsing Smithy AST...');
  const ast = JSON.parse(await fs.readFile(rawModelPath, 'utf-8'));
  
  if (!ast?.shapes || !ast.shapes['com.amazonaws.s3#AmazonS3']?.operations) {
    throw new Error('Could not find com.amazonaws.s3#AmazonS3 operations in the Smithy AST.');
  }

  const originalOperations = ast.shapes['com.amazonaws.s3#AmazonS3'].operations;
  
  // Filter the service operations
  const filteredOperations = originalOperations.filter((op: any) => {
    const opName = op.target.split('#')[1];
    return requiredOperations.has(opName);
  });
  
  ast.shapes['com.amazonaws.s3#AmazonS3'].operations = filteredOperations;

  // Strip AWS-specific rules-engine traits from the service shape to prevent compilation validation errors.
  // These traits reference operations and parameters we filter out for the Tier 1 core subset.
  const serviceTraits = ast.shapes['com.amazonaws.s3#AmazonS3'].traits;
  if (serviceTraits) {
    console.log('Stripping AWS-specific endpoint rules and test traits from service shape...');
    delete serviceTraits['smithy.rules#clientContextParams'];
    delete serviceTraits['smithy.rules#endpointRuleSet'];
    delete serviceTraits['smithy.rules#endpointBdd'];
    delete serviceTraits['smithy.rules#endpointTests'];
    delete serviceTraits['aws.api#service'];
  }

  // Track shape to operations mapping
  const shapeToOps = new Map<string, Set<string>>();

  function addTransitiveReferences(shapeId: string, opName: string) {
    let opSet = shapeToOps.get(shapeId);
    if (!opSet) {
      opSet = new Set<string>();
      shapeToOps.set(shapeId, opSet);
    }
    if (opSet.has(opName)) return;
    opSet.add(opName);

    const shapeDef = ast.shapes[shapeId];
    if (!shapeDef) return;

    if (shapeDef.members) {
      for (const member of Object.values<any>(shapeDef.members)) {
        if (member.target) {
          addTransitiveReferences(member.target, opName);
        }
      }
    }
    if (shapeDef.member?.target) {
      addTransitiveReferences(shapeDef.member.target, opName);
    }
    if (shapeDef.key?.target) {
      addTransitiveReferences(shapeDef.key.target, opName);
    }
    if (shapeDef.value?.target) {
      addTransitiveReferences(shapeDef.value.target, opName);
    }
  }

  // Seed transitive references per operation
  for (const opRef of filteredOperations) {
    const opId = opRef.target;
    const opName = opId.split('#')[1];
    const opDef = ast.shapes[opId];
    if (opDef) {
      addTransitiveReferences(opId, opName);
      if (opDef.input?.target) addTransitiveReferences(opDef.input.target, opName);
      if (opDef.output?.target) addTransitiveReferences(opDef.output.target, opName);
      if (opDef.errors) {
        for (const err of opDef.errors) {
          if (err.target) addTransitiveReferences(err.target, opName);
        }
      }
    }
  }

  // Clean out unrelated shapes from the AST
  for (const shapeId of Object.keys(ast.shapes)) {
    if (shapeId === 'com.amazonaws.s3#AmazonS3') continue;
    const ops = shapeToOps.get(shapeId);
    if (!ops || ops.size === 0) {
      delete ast.shapes[shapeId];
    }
  }

  // Resolve documentation inheritance (fallback to target shape's documentation if member has none)
  console.log('Resolving documentation inheritance...');
  for (const [shapeId, shapeDef] of Object.entries<any>(ast.shapes)) {
    if (shapeDef.members) {
      for (const memberDef of Object.values<any>(shapeDef.members)) {
        if (!memberDef.traits?.['smithy.api#documentation'] && memberDef.target) {
          const targetShape = ast.shapes[memberDef.target];
          const targetDoc = targetShape?.traits?.['smithy.api#documentation'];
          if (targetDoc) {
            if (!memberDef.traits) memberDef.traits = {};
            memberDef.traits['smithy.api#documentation'] = targetDoc;
          }
        }
      }
    }
  }

  // Sanitize all documentation traits in the filtered AST
  console.log('Sanitizing documentation traits in AST...');
  for (const [shapeId, shapeDef] of Object.entries<any>(ast.shapes)) {
    if (shapeDef.traits) {
      if (shapeDef.traits['smithy.api#documentation']) {
        shapeDef.traits['smithy.api#documentation'] = sanitizeDocumentation(shapeDef.traits['smithy.api#documentation']);
      }
    }
    if (shapeDef.members) {
      for (const memberDef of Object.values<any>(shapeDef.members)) {
        if (memberDef.traits) {
          if (memberDef.traits['smithy.api#documentation']) {
            memberDef.traits['smithy.api#documentation'] = sanitizeDocumentation(memberDef.traits['smithy.api#documentation']);
          }
        }
      }
    }
  }

  // Helper functions for hybrid Markdown generation
  function getCleanTypeString(shapeId: string, rawAst: any): string {
    const shape = rawAst.shapes[shapeId];
    if (!shape) return 'string';
    if (shape.type === 'integer' || shape.type === 'long') return 'integer';
    if (shape.type === 'boolean') return 'boolean';
    if (shape.type === 'timestamp') return 'timestamp';
    if (shape.type === 'blob') return 'blob';
    if (shape.type === 'list') return 'array';
    if (shape.type === 'structure') return 'object';
    return 'string';
  }

  function getSchemaLinkMarkdown(targetId: string, rawAst: any): string {
    const shape = rawAst.shapes[targetId];
    if (!shape) return '';

    const shortName = targetId.split('#')[1] || targetId;

    if (shape.type === 'structure') {
      return `\nType: [${shortName}](shared-shapes.md#schema-${shortName.toLowerCase()})`;
    }
    if (shape.type === 'list' || shape.type === 'set') {
      const memberTargetId = shape.member.target;
      const memberShape = rawAst.shapes[memberTargetId];
      if (memberShape && memberShape.type === 'structure') {
        const memberShortName = memberTargetId.split('#')[1] || memberTargetId;
        return `\nType: Array of [${memberShortName}](shared-shapes.md#schema-${memberShortName.toLowerCase()})`;
      }
    }
    if (shape.type === 'map') {
      const valueTargetId = shape.value.target;
      const valueShape = rawAst.shapes[valueTargetId];
      if (valueShape && valueShape.type === 'structure') {
        const valueShortName = valueTargetId.split('#')[1] || valueTargetId;
        return `\nType: Map of [${valueShortName}](shared-shapes.md#schema-${valueShortName.toLowerCase()})`;
      }
    }
    return '';
  }

  function isMemberRequired(memberDef: any): boolean {
    return !!memberDef.traits?.['smithy.api#required'];
  }

  function generateShapeXmlMock(shapeId: string, rawAst: any, visited: Set<string>, level = 1, isFlattened = false): string {
    if (visited.has(shapeId)) return '...';
    const shape = rawAst.shapes[shapeId];
    if (!shape) return 'string';

    if (shape.type === 'integer' || shape.type === 'long') return 'integer';
    if (shape.type === 'double' || shape.type === 'float') return 'double';
    if (shape.type === 'boolean') return 'boolean';
    if (shape.type === 'timestamp') return 'timestamp';
    if (shape.type === 'string') return 'string';

    // tabs allows user defined tab width: 
    // see: https://github.blog/changelog/2025-07-24-github-consistently-maintains-user-defined-tab-width-preferences/
    const indent = '\t'.repeat(level);

    if (shape.type === 'list' || shape.type === 'set') {
      const memberTargetId = shape.member.target;
      const memberXmlName = shape.member.traits?.['smithy.api#xmlName'] || 'member';
      
      const newVisited = new Set(visited);
      newVisited.add(shapeId);
      
      if (isFlattened) {
        return generateShapeXmlMock(memberTargetId, rawAst, newVisited, level, false);
      } else {
        const valStr = generateShapeXmlMock(memberTargetId, rawAst, newVisited, level + 1, false);
        if (valStr.includes('\n')) {
          return `\n${indent}<${memberXmlName}>${valStr}\n${indent}</${memberXmlName}>`;
        } else {
          return `\n${indent}<${memberXmlName}>${valStr}</${memberXmlName}>`;
        }
      }
    }

    if (shape.type === 'structure') {
      const newVisited = new Set(visited);
      newVisited.add(shapeId);
      
      let xml = '';
      if (shape.members) {
        for (const [mName, mDef] of Object.entries<any>(shape.members)) {
          const mTargetId = mDef.target;
          const mTagName = mDef.traits?.['smithy.api#xmlName'] || mName;
          const targetShape = rawAst.shapes[mTargetId];
          const mIsFlattened = mDef.traits?.['smithy.api#xmlFlattened'] !== undefined || targetShape?.traits?.['smithy.api#xmlFlattened'] !== undefined;
          
          const val = generateShapeXmlMock(mTargetId, rawAst, newVisited, level + 1, mIsFlattened);
          
          const memberIndent = '\t'.repeat(level + 1);
          if (val.includes('\n')) {
            xml += `\n${memberIndent}<${mTagName}>${val}\n${memberIndent}</${mTagName}>`;
          } else {
            xml += `\n${memberIndent}<${mTagName}>${val}</${mTagName}>`;
          }
        }
      }
      return xml;
    }
    
    return 'string';
  }

  function generateXmlMock(outputShapeId: string, rawAst: any, opDef?: any): string {
    const outputShape = rawAst.shapes[outputShapeId];
    if (!outputShape || outputShape.type !== 'structure') return '';

    // If s3UnwrappedXmlOutput trait is on the operation, the root element is the xmlName of the single member
    if (opDef?.traits?.['aws.customizations#s3UnwrappedXmlOutput'] !== undefined) {
      const members = Object.entries<any>(outputShape.members || {});
      const firstMember = members[0];
      if (firstMember) {
        const [memberName, memberDef] = firstMember;
        const targetId = memberDef.target;
        const xmlName = memberDef.traits?.['smithy.api#xmlName'] || memberName;
        
        const visited = new Set<string>();
        visited.add(outputShapeId);
        const valStr = generateShapeXmlMock(targetId, rawAst, visited, 0);
        
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        if (valStr.includes('\n')) {
          xml += `<${xmlName}>${valStr}\n</${xmlName}>`;
        } else {
          xml += `<${xmlName}>${valStr}</${xmlName}>`;
        }
        return xml;
      }
    }

    const xmlName = outputShape.traits?.['smithy.api#xmlName'] || outputShapeId.split('#')[1];
    
    const visited = new Set<string>();
    visited.add(outputShapeId);
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<${xmlName}>`;
    if (outputShape.members) {
      for (const [memberName, memberDef] of Object.entries<any>(outputShape.members)) {
        if (memberDef.traits?.['smithy.api#httpHeader'] || 
            memberDef.traits?.['smithy.api#httpPrefixHeaders'] || 
            memberDef.traits?.['smithy.api#httpResponseCode']) continue;
        const targetId = memberDef.target;
        const targetShape = rawAst.shapes[targetId];
        const tagName = memberDef.traits?.['smithy.api#xmlName'] || memberName;
        const isFlattened = memberDef.traits?.['smithy.api#xmlFlattened'] !== undefined || targetShape?.traits?.['smithy.api#xmlFlattened'] !== undefined;
        
        const val = generateShapeXmlMock(targetId, rawAst, visited, 1, isFlattened);
        
        if (val.includes('\n')) {
          xml += `\n\t<${tagName}>${val}\n\t</${tagName}>`;
        } else {
          xml += `\n\t<${tagName}>${val}</${tagName}>`;
        }
      }
    }
    xml += `\n</${xmlName}>`;
    return xml;
  }

  function generateOperationMarkdown(opName: string, opId: string, opDef: any, shapesInPartition: any, rawAst: any): string {
    const http = opDef.traits?.['smithy.api#http'];
    const method = http?.method;
    const successCode = http ? (http.code || (method === 'DELETE' ? 204 : 200)) : 200;

    let md = `# ${opName}\n\n[Request](#request) → [Response](#response-${successCode}-success) 𝄁 [Error](#errors)\n\n`;
    const opDoc = opDef.traits?.['smithy.api#documentation'] || '';
    md += `${opDoc}\n\n`;
    
    if (shapesInPartition[opId]?.traits?.['smithy.api#documentation']) {
      shapesInPartition[opId].traits['smithy.api#documentation'] = { "$ref": `#${opName.toLowerCase()}` };
    }
    
    const inputId = opDef.input?.target;
    const inputShape = inputId ? rawAst.shapes[inputId] : null;
    const outputId = opDef.output?.target;
    const outputShape = outputId ? rawAst.shapes[outputId] : null;
    const ignoreShapes = new Set<string>([opId, inputId, outputId].filter(Boolean));

    md += `## Request\n\n`;
    const httpTrait = opDef.traits?.['smithy.api#http'];
    if (httpTrait) {
      const method = httpTrait.method;
      let uri = httpTrait.uri;
      uri = uri
        .replace(/([?&])x-id=[A-Za-z0-9_]+&?/g, '$1')
        .replace(/[?&]$/, '');
      uri = uri.replace(/{([A-Za-z0-9_]+)\+}/g, '{$1}').replace(/{([A-Za-z0-9_]+)}/g, (m: string, g: string) => `{${g.toLowerCase()}}`);
      
      let httpBlock = `\`\`\`HTTP\n${method} ${uri} HTTP/1.1\n`;
      if (inputShape && inputShape.members) {
        for (const [memberName, memberDef] of Object.entries<any>(inputShape.members)) {
          if (memberDef.traits?.['smithy.api#required'] !== undefined) {
            if (memberDef.traits?.['smithy.api#httpHeader']) {
              const headerName = memberDef.traits['smithy.api#httpHeader'];
              httpBlock += `${headerName}: {${memberName}}\n`;
            }
          }
        }
      }
      httpBlock += `\`\`\`\n\n`;
      md += httpBlock;
    }
    
    if (inputShape && inputShape.members) {
      const paths: { memberName: string, memberDef: any, traits: any, doc: string }[] = [];
      const queries: { memberName: string, memberDef: any, traits: any, doc: string }[] = [];
      const headers: { memberName: string, memberDef: any, traits: any, doc: string }[] = [];

      for (const [memberName, memberDef] of Object.entries<any>(inputShape.members)) {
        const traits = memberDef.traits || {};
        const doc = traits['smithy.api#documentation'] || '';
        if (traits['smithy.api#httpLabel']) {
          paths.push({ memberName, memberDef, traits, doc });
        } else if (traits['smithy.api#httpQuery']) {
          queries.push({ memberName, memberDef, traits, doc });
        } else if (traits['smithy.api#httpHeader']) {
          headers.push({ memberName, memberDef, traits, doc });
        } else if (traits['smithy.api#httpPrefixHeaders']) {
          headers.push({ memberName, memberDef, traits, doc });
        }
      }

      for (const p of paths) {
        const paramName = p.memberName.toLowerCase();
        const typeLink = getSchemaLinkMarkdown(p.memberDef.target, rawAst);
        md += `### Path: \`${paramName}\`\n${p.doc}${typeLink}\n\n`;
        if (shapesInPartition[inputId]?.members?.[p.memberName]?.traits?.['smithy.api#documentation']) {
          shapesInPartition[inputId].members[p.memberName].traits['smithy.api#documentation'] = { "$ref": `#path-${paramName}` };
        }
      }

      for (const q of queries) {
        const queryName = q.traits['smithy.api#httpQuery'];
        const typeLink = getSchemaLinkMarkdown(q.memberDef.target, rawAst);
        md += `### Query: \`${queryName}\`\n${q.doc}${typeLink}\n\n`;
        if (shapesInPartition[inputId]?.members?.[q.memberName]?.traits?.['smithy.api#documentation']) {
          shapesInPartition[inputId].members[q.memberName].traits['smithy.api#documentation'] = { "$ref": `#query-${queryName.toLowerCase()}` };
        }
      }

      for (const h of headers) {
        const rawHeaderName = h.traits['smithy.api#httpHeader'] || (h.traits['smithy.api#httpPrefixHeaders'] + '*');
        const headerName = rawHeaderName.toLowerCase();
        const typeLink = getSchemaLinkMarkdown(h.memberDef.target, rawAst);
        md += `### Header: \`${headerName}\`\n${h.doc}${typeLink}\n\n`;
        if (shapesInPartition[inputId]?.members?.[h.memberName]?.traits?.['smithy.api#documentation']) {
          shapesInPartition[inputId].members[h.memberName].traits['smithy.api#documentation'] = { "$ref": `#header-${headerName}` };
        }
      }
      
      let payloadMemberName = '';
      let payloadMemberDef: any = null;
      for (const [mName, mDef] of Object.entries<any>(inputShape.members)) {
        if (mDef.traits?.['smithy.api#httpPayload']) {
          payloadMemberName = mName;
          payloadMemberDef = mDef;
          break;
        }
      }
      
      if (payloadMemberName) {
        const payloadTargetId = payloadMemberDef.target;
        const payloadShape = rawAst.shapes[payloadTargetId];
        const payloadDoc = payloadMemberDef.traits?.['smithy.api#documentation'] || payloadShape?.traits?.['smithy.api#documentation'] || '';
        const payloadXmlName = payloadMemberDef.traits?.['smithy.api#xmlName'] || payloadTargetId.split('#')[1];
        
        if (payloadShape && payloadShape.type === 'structure') {
          const typeLink = getSchemaLinkMarkdown(payloadTargetId, rawAst);
          md += `### Body: \`<${payloadXmlName}>\`\n${payloadDoc}${typeLink}\n\n`;
          if (shapesInPartition[inputId]?.members?.[payloadMemberName]?.traits?.['smithy.api#documentation']) {
            shapesInPartition[inputId].members[payloadMemberName].traits['smithy.api#documentation'] = { "$ref": `#body-${payloadXmlName.toLowerCase()}` };
          }
          
          // Only inline members of payloadShape if it is defined locally (e.g. input/output shape itself)
          const isPayloadLocal = payloadTargetId === inputId || payloadTargetId === outputId;
          if (isPayloadLocal && payloadShape.members) {
            for (const [subName, subDef] of Object.entries<any>(payloadShape.members)) {
              const subDoc = subDef.traits?.['smithy.api#documentation'] || '';
              const subXmlName = subDef.traits?.['smithy.api#xmlName'] || subName;
              const subTypeLink = getSchemaLinkMarkdown(subDef.target, rawAst);
              md += `#### \`<${subXmlName}>\`\n${subDoc}${subTypeLink}\n\n`;
              if (shapesInPartition[payloadTargetId]?.members?.[subName]?.traits?.['smithy.api#documentation']) {
                shapesInPartition[payloadTargetId].members[subName].traits['smithy.api#documentation'] = { "$ref": `#${subXmlName.toLowerCase()}` };
              }
            }
          }
        } else {
          const payloadType = getCleanTypeString(payloadTargetId, rawAst);
          const typeLink = getSchemaLinkMarkdown(payloadTargetId, rawAst);
          md += `### Body: \`${payloadType}\`\n${payloadDoc}${typeLink}\n\n`;
          if (shapesInPartition[inputId]?.members?.[payloadMemberName]?.traits?.['smithy.api#documentation']) {
            shapesInPartition[inputId].members[payloadMemberName].traits['smithy.api#documentation'] = { "$ref": `#body-${payloadType.toLowerCase()}` };
          }
        }
      } else {
        const payloadMembers = Object.entries<any>(inputShape.members).filter(
          ([_, mDef]) => !mDef.traits?.['smithy.api#httpLabel'] && 
                         !mDef.traits?.['smithy.api#httpQuery'] && 
                         !mDef.traits?.['smithy.api#httpHeader'] &&
                         !mDef.traits?.['smithy.api#httpPrefixHeaders'] &&
                         !mDef.traits?.['smithy.api#httpQueryParams']
        );
        if (payloadMembers.length > 0) {
          const inputXmlName = inputShape.traits?.['smithy.api#xmlName'] || inputId.split('#')[1];
          md += `### Body: \`<${inputXmlName}>\`\n${inputShape.traits?.['smithy.api#documentation'] || ''}\n\n`;
          if (shapesInPartition[inputId]?.traits?.['smithy.api#documentation']) {
            shapesInPartition[inputId].traits['smithy.api#documentation'] = { "$ref": `#body-${inputXmlName.toLowerCase()}` };
          }
          for (const [mName, mDef] of payloadMembers) {
            const subDoc = mDef.traits?.['smithy.api#documentation'] || '';
            const subXmlName = mDef.traits?.['smithy.api#xmlName'] || mName;
            const typeLink = getSchemaLinkMarkdown(mDef.target, rawAst);
            md += `#### \`<${subXmlName}>\`\n${subDoc}${typeLink}\n\n`;
            if (shapesInPartition[inputId]?.members?.[mName]?.traits?.['smithy.api#documentation']) {
              shapesInPartition[inputId].members[mName].traits['smithy.api#documentation'] = { "$ref": `#${subXmlName.toLowerCase()}` };
            }
          }
        }
      }
    }
    
    if (httpTrait) {
      const method = httpTrait.method;
      const successCode = httpTrait.code || (method === 'DELETE' ? 204 : 200);
      let statusText = 'OK';
      if (successCode === 204) statusText = 'No Content';
      
      md += `## Response: \`${successCode}\` Success\n\n`;
      md += `\`\`\`HTTP\nHTTP/1.1 ${successCode} ${statusText}\n`;
      

      let hasPayloadBody = false;
      let responseXml = '';
      
      if (outputShape && outputShape.members) {
        let payloadMemberName = '';
        let payloadMemberDef: any = null;
        for (const [mName, mDef] of Object.entries<any>(outputShape.members)) {
          if (mDef.traits?.['smithy.api#httpPayload']) {
            payloadMemberName = mName;
            payloadMemberDef = mDef;
            break;
          }
        }

        const payloadMembers = Object.entries<any>(outputShape.members).filter(
          ([_, mDef]) => !mDef.traits?.['smithy.api#httpHeader'] && 
                         !mDef.traits?.['smithy.api#httpPrefixHeaders'] && 
                         !mDef.traits?.['smithy.api#httpResponseCode']
        );

        if (payloadMemberName) {
          const payloadTargetId = payloadMemberDef.target;
          const payloadShape = rawAst.shapes[payloadTargetId];
          
          if (payloadShape && payloadShape.type === 'structure') {
            hasPayloadBody = true;
            md += `Content-Type: application/xml\n\n`;
            responseXml = generateXmlMock(payloadTargetId, rawAst, opDef);
            md += `${responseXml}\n`;
          } else {
            md += `Content-Type: application/octet-stream\n\n`;
            md += `[Binary Data]\n`;
          }
        } else if (payloadMembers.length > 0) {
          hasPayloadBody = true;
          md += `Content-Type: application/xml\n\n`;
          responseXml = generateXmlMock(outputId, rawAst, opDef);
          md += `${responseXml}\n`;
        } else {
          md += `\n`;
        }
      } else {
        md += `\n`;
      }
      md += `\`\`\`\n\n`;
      
      if (outputShape && outputShape.members) {
        for (const [memberName, memberDef] of Object.entries<any>(outputShape.members)) {
          const traits = memberDef.traits || {};
          if (traits['smithy.api#httpHeader'] || traits['smithy.api#httpPrefixHeaders']) {
            const rawHeaderName = traits['smithy.api#httpHeader'] || (traits['smithy.api#httpPrefixHeaders'] + '*');
            const headerName = rawHeaderName.toLowerCase();
            const doc = traits['smithy.api#documentation'] || '';
            const typeLink = getSchemaLinkMarkdown(memberDef.target, rawAst);
            md += `### Response Header: \`${headerName}\`\n${doc}${typeLink}\n\n`;
            if (shapesInPartition[outputId]?.members?.[memberName]?.traits?.['smithy.api#documentation']) {
              shapesInPartition[outputId].members[memberName].traits['smithy.api#documentation'] = { "$ref": `#response-header-${headerName}` };
            }
          }
        }
        
        let payloadMemberName = '';
        let payloadMemberDef: any = null;
        for (const [mName, mDef] of Object.entries<any>(outputShape.members)) {
          if (mDef.traits?.['smithy.api#httpPayload']) {
            payloadMemberName = mName;
            payloadMemberDef = mDef;
            break;
          }
        }
        
        if (payloadMemberName) {
          const payloadTargetId = payloadMemberDef.target;
          const payloadShape = rawAst.shapes[payloadTargetId];
          const payloadDoc = payloadMemberDef.traits?.['smithy.api#documentation'] || payloadShape?.traits?.['smithy.api#documentation'] || '';
          const payloadXmlName = payloadMemberDef.traits?.['smithy.api#xmlName'] || payloadTargetId.split('#')[1];
          
          if (payloadShape && payloadShape.type === 'structure') {
            const typeLink = getSchemaLinkMarkdown(payloadTargetId, rawAst);
            md += `### Body: \`<${payloadXmlName}>\`\n${payloadDoc}${typeLink}\n\n`;
            if (shapesInPartition[outputId]?.members?.[payloadMemberName]?.traits?.['smithy.api#documentation']) {
              shapesInPartition[outputId].members[payloadMemberName].traits['smithy.api#documentation'] = { "$ref": `#body-${payloadXmlName.toLowerCase()}` };
            }
            
            // Only inline members of payloadShape if it is defined locally (e.g. input/output shape itself)
            const isPayloadLocal = payloadTargetId === inputId || payloadTargetId === outputId;
            if (isPayloadLocal && payloadShape.members) {
              for (const [subName, subDef] of Object.entries<any>(payloadShape.members)) {
                const subDoc = subDef.traits?.['smithy.api#documentation'] || '';
                const subXmlName = subDef.traits?.['smithy.api#xmlName'] || subName;
                const subTypeLink = getSchemaLinkMarkdown(subDef.target, rawAst);
                md += `#### \`<${subXmlName}>\`\n${subDoc}${subTypeLink}\n\n`;
                if (shapesInPartition[payloadTargetId]?.members?.[subName]?.traits?.['smithy.api#documentation']) {
                  shapesInPartition[payloadTargetId].members[subName].traits['smithy.api#documentation'] = { "$ref": `#${subXmlName.toLowerCase()}` };
                }
              }
            }
          } else {
            const payloadType = getCleanTypeString(payloadTargetId, rawAst);
            const typeLink = getSchemaLinkMarkdown(payloadTargetId, rawAst);
            md += `### Body: \`${payloadType}\`\n${payloadDoc}${typeLink}\n\n`;
            if (shapesInPartition[outputId]?.members?.[payloadMemberName]?.traits?.['smithy.api#documentation']) {
              shapesInPartition[outputId].members[payloadMemberName].traits['smithy.api#documentation'] = { "$ref": `#body-${payloadType.toLowerCase()}` };
            }
          }
        } else {
          const payloadMembers = Object.entries<any>(outputShape.members).filter(
            ([_, mDef]) => !mDef.traits?.['smithy.api#httpHeader'] && 
                           !mDef.traits?.['smithy.api#httpPrefixHeaders'] && 
                           !mDef.traits?.['smithy.api#httpResponseCode']
          );
          if (payloadMembers.length > 0) {
            const outputXmlName = outputShape.traits?.['smithy.api#xmlName'] || outputId.split('#')[1];
            md += `### Body: \`<${outputXmlName}>\`\n${outputShape.traits?.['smithy.api#documentation'] || ''}\n\n`;
            if (shapesInPartition[outputId]?.traits?.['smithy.api#documentation']) {
              shapesInPartition[outputId].traits['smithy.api#documentation'] = { "$ref": `#body-${outputXmlName.toLowerCase()}` };
            }
            for (const [mName, mDef] of payloadMembers) {
              const subDoc = mDef.traits?.['smithy.api#documentation'] || '';
              const subXmlName = mDef.traits?.['smithy.api#xmlName'] || mName;
              const typeLink = getSchemaLinkMarkdown(mDef.target, rawAst);
              md += `#### \`<${subXmlName}>\`\n${subDoc}${typeLink}\n\n`;
              if (shapesInPartition[outputId]?.members?.[mName]?.traits?.['smithy.api#documentation']) {
                shapesInPartition[outputId].members[mName].traits['smithy.api#documentation'] = { "$ref": `#${subXmlName.toLowerCase()}` };
              }
            }
          }
        }
      }
    }

    if (opDef.errors && opDef.errors.length > 0) {
      md += `## Errors\n\n`;
      for (const errRef of opDef.errors) {
        const errTargetId = errRef.target;
        const errShape = rawAst.shapes[errTargetId];
        if (errShape) {
          const errName = errTargetId.split('#')[1] || errTargetId;
          const errDoc = errShape.traits?.['smithy.api#documentation'] || '';
          let httpCode = errShape.traits?.['smithy.api#httpError'];
          if (!httpCode && errName === 'NotFound') {
            httpCode = 404;
          }
          const errHeader = httpCode ? `### \`${httpCode}\` \`${errName}\`` : `### \`${errName}\``;
          md += `${errHeader}\n${errDoc}\n\n`;

          if (httpTrait?.method !== 'HEAD' && httpCode) {
            const reasonPhrases: Record<number, string> = {
              301: 'Moved Permanently',
              307: 'Temporary Redirect',
              400: 'Bad Request',
              403: 'Forbidden',
              404: 'Not Found',
              405: 'Method Not Allowed',
              409: 'Conflict',
              411: 'Length Required',
              412: 'Precondition Failed',
              416: 'Range Not Satisfiable',
              500: 'Internal Server Error',
              501: 'Not Implemented',
              503: 'Service Unavailable'
            };
            const reason = reasonPhrases[httpCode] || 'Error';
            md += `\`\`\`HTTP\nHTTP/1.1 ${httpCode} ${reason}\nContent-Type: application/xml\n\n`;
            md += `<?xml version="1.0" encoding="UTF-8"?>\n`;
            md += `<Error>\n`;
            md += `\t<Code>${errName}</Code>\n`;
            md += `\t<Message>${errDoc.trim()}</Message>\n`;
            md += `</Error>\n`;
            md += `\`\`\`\n\n`;
          }
        }
      }
    }

    for (const [shapeId, shapeDef] of Object.entries<any>(shapesInPartition)) {
      if (ignoreShapes.has(shapeId)) continue;
      if (!shapeDef.traits?.['smithy.api#documentation'] && !shapeDef.members) {
        continue;
      }
      const shortName = shapeId.split('#')[1] || shapeId;
      md += `## Schema: ${shortName}\n${shapeDef.traits?.['smithy.api#documentation'] || ''}\n\n`;
      if (shapeDef.traits?.['smithy.api#documentation']) {
        shapeDef.traits['smithy.api#documentation'] = { "$ref": `#schema-${shortName.toLowerCase()}` };
      }
      if (shapeDef.members) {
        for (const [mName, mDef] of Object.entries<any>(shapeDef.members)) {
          const docTrait = mDef.traits?.['smithy.api#documentation'];
          if (docTrait && typeof docTrait === 'object' && docTrait.$ref) {
            continue;
          }
          const mDoc = docTrait || '';
          md += `### ${shortName}$${mName}\n${mDoc}\n\n`;
          if (mDef.traits?.['smithy.api#documentation']) {
            mDef.traits['smithy.api#documentation'] = { "$ref": `#${shortName.toLowerCase()}${mName.toLowerCase()}` };
          }
        }
      }
    }
    
    md += `## Smithy Spec\n\n<details>\n\n\`\`\`json\n`;
    md += JSON.stringify({ smithy: "2.0", shapes: shapesInPartition }, null, 2);
    md += `\n\`\`\`\n\n</details>\n`;
    
    return md;
  }

  function getSchemaCategory(shortName: string, shapeDef: any): string {
    const isError = shapeDef.traits?.['smithy.api#error'] !== undefined || 
                    shortName.endsWith('Error') || 
                    shortName.endsWith('Exception') ||
                    ['BucketAlreadyExists', 'BucketAlreadyOwnedByYou', 'EncryptionTypeMismatch', 'NotFound', 'InvalidRequest', 'InvalidWriteOffset', 'TooManyParts'].includes(shortName);
    if (isError) return 'Errors';

    const isEnum = shapeDef.type === 'enum' || 
                   shapeDef.traits?.['smithy.api#enum'] !== undefined ||
                   ['ArchiveStatus', 'BucketCannedACL', 'BucketLocationConstraint', 'BucketNamespace', 'BucketType', 
                    'ChecksumAlgorithm', 'ChecksumMode', 'ChecksumType', 'DataRedundancy', 'EncodingType', 
                    'IntelligentTieringAccessTier', 'LocationType', 'MetadataDirective', 'ObjectCannedACL', 
                    'ObjectLockLegalHoldStatus', 'ObjectLockMode', 'ObjectOwnership', 'ObjectStorageClass', 
                    'ReplicationStatus', 'RequestCharged', 'RequestPayer', 'ServerSideEncryption', 'StorageClass', 
                    'TaggingDirective'].includes(shortName);
    if (isEnum) return 'Enums & Constants';

    if (['Bucket', 'Object', 'Owner', 'CommonPrefix', 'DeletedObject'].includes(shortName)) {
      return 'Core Resources';
    }

    return 'Configuration & Payloads';
  }

  function generateIndexMarkdown(): string {
    let md = `# S3 Storage API\nShared schema definitions for S3 operations.\n\n`;
    md += `## Overview\n\n`;
    md += `Welcome to the S3 Storage API specification index. This index defines the shared structures, data types, enumerations, and error schemas used by S3 operations. The operations themselves are documented in detail in their respective files.\n\n`;
    md += `## Operations\n\n`;
    md += `| Operation | Description |\n`;
    md += `| :--- | :--- |\n`;
    const orderedOps = Array.from(requiredOperations);
    for (const opName of orderedOps) {
      const opId = `com.amazonaws.s3#${opName}`;
      const opDef = ast.shapes[opId];
      const rawDoc = opDef?.traits?.['smithy.api#documentation'] || '';
      const doc = getShortDescription(rawDoc);
      md += `| [\`${opName}\`](${opName}.md) | ${doc} |\n`;
    }
    md += `\n`;
    return md;
  }

  function generateSharedShapesMarkdown(shapesInPartition: any, rawAst: any): string {
    let md = `# Shared Schemas\nShared schema definitions for S3 operations.\n\n`;
    
    const categories: {
      'Core Resources': { shapeId: string, shapeDef: any }[];
      'Configuration & Payloads': { shapeId: string, shapeDef: any }[];
      'Enums & Constants': { shapeId: string, shapeDef: any }[];
      'Errors': { shapeId: string, shapeDef: any }[];
    } = {
      'Core Resources': [],
      'Configuration & Payloads': [],
      'Enums & Constants': [],
      'Errors': []
    };

    for (const [shapeId, shapeDef] of Object.entries<any>(shapesInPartition)) {
      if (shapeId === 'com.amazonaws.s3#AmazonS3') {
        if (shapeDef.traits?.['smithy.api#documentation'] !== undefined) {
          shapeDef.traits['smithy.api#documentation'] = { "$ref": "#shared-schemas" };
        }
        continue;
      }
      const shortName = shapeId.split('#')[1] || shapeId;
      const cat = getSchemaCategory(shortName, shapeDef) as keyof typeof categories;
      if (categories[cat]) {
        categories[cat].push({ shapeId, shapeDef });
      } else {
        categories['Configuration & Payloads'].push({ shapeId, shapeDef });
      }
    }

    const catEmojis: Record<string, string> = {
      'Core Resources': '📦',
      'Configuration & Payloads': '⚙️',
      'Enums & Constants': '🏷️',
      'Errors': '🚨'
    };

    const catDescriptions: Record<string, string> = {
      'Core Resources': 'Core resource shapes representing the primary entities in object storage.',
      'Configuration & Payloads': 'Structure shapes used for parameters, configuration options, and payload bodies.',
      'Enums & Constants': 'Enumerations, options, and fixed string constants.',
      'Errors': 'Common error response schemas returned when operations fail.'
    };

    let enumValueDetails = `<details>\n<summary>Enum Value Details</summary>\n\n`;
    let hasEnumDetails = false;

    for (const [catName, shapesList] of Object.entries(categories)) {
      if (shapesList.length === 0) continue;
      
      md += `## ${catName}\n\n`;
      const desc = catDescriptions[catName];
      if (desc) {
        md += `${desc}\n\n`;
      }
      
      const sortedShapes = shapesList.sort((a, b) => a.shapeId.localeCompare(b.shapeId));
      for (const { shapeId, shapeDef } of sortedShapes) {
        const shortName = shapeId.split('#')[1] || shapeId;
        const isComplex = shapeDef.type === 'structure' || shapeDef.type === 'union' || shapeDef.type === 'enum';
        if (!isComplex && !shapeDef.traits?.['smithy.api#documentation']) {
          continue;
        }
        if (shapeDef.type === 'enum') {
          md += `### Schema: ${shortName}\n${shapeDef.traits?.['smithy.api#documentation'] || ''}\n\n`;
          if (shapeDef.traits?.['smithy.api#documentation'] !== undefined) {
            shapeDef.traits['smithy.api#documentation'] = { "$ref": `#schema-${shortName.toLowerCase()}` };
          }
          
          md += `#### Values\n\n`;
          md += `| Member | Value | Description |\n`;
          md += `| :--- | :--- | :--- |\n`;
          
          if (shapeDef.members) {
            for (const [mName, mDef] of Object.entries<any>(shapeDef.members)) {
              const mDoc = mDef.traits?.['smithy.api#documentation'] || '';
              const enumValue = mDef.traits?.['smithy.api#enumValue'] || mName;
              md += `| \`${mName}\` | \`${enumValue}\` | ${mDoc.replace(/\r?\n/g, ' ')} |\n`;
              
              enumValueDetails += `#### ${shortName}$${mName}\n${mDoc}\n\n`;
              hasEnumDetails = true;
              
              if (mDef.traits?.['smithy.api#documentation']) {
                mDef.traits['smithy.api#documentation'] = { "$ref": `#${shortName.toLowerCase()}${mName.toLowerCase()}` };
              }
            }
          }
          md += `\n`;
        } else {
          if (catName === 'Errors') {
            let httpCode = shapeDef.traits?.['smithy.api#httpError'];
            if (!httpCode && shortName === 'NotFound') {
              httpCode = 404;
            }
            const headerText = httpCode ? `Schema: \`${httpCode}\` \`${shortName}\`` : `Schema: \`${shortName}\``;
            md += `### ${headerText}\n${shapeDef.traits?.['smithy.api#documentation'] || ''}\n\n`;
            
            const slug = httpCode ? `schema-${httpCode}-${shortName.toLowerCase()}` : `schema-${shortName.toLowerCase()}`;
            if (shapeDef.traits?.['smithy.api#documentation'] !== undefined) {
              shapeDef.traits['smithy.api#documentation'] = { "$ref": `#${slug}` };
            }
          } else {
            md += `### Schema: ${shortName}\n${shapeDef.traits?.['smithy.api#documentation'] || ''}\n\n`;
            if (shapeDef.traits?.['smithy.api#documentation'] !== undefined) {
              shapeDef.traits['smithy.api#documentation'] = { "$ref": `#schema-${shortName.toLowerCase()}` };
            }
          }
          if (shapeDef.members) {
            for (const [mName, mDef] of Object.entries<any>(shapeDef.members)) {
              const mDoc = mDef.traits?.['smithy.api#documentation'] || '';
              md += `#### ${shortName}$${mName}\n${mDoc}\n\n`;
              if (mDef.traits?.['smithy.api#documentation']) {
                mDef.traits['smithy.api#documentation'] = { "$ref": `#${shortName.toLowerCase()}${mName.toLowerCase()}` };
              }
            }
          }
        }
      }
    }

    if (hasEnumDetails) {
      enumValueDetails += `#### End of Details\n</details>\n\n`;
      md += `## Schema Details\n\n` + enumValueDetails;
    }
    
    md += `## Smithy Spec\n\n<details>\n\n\`\`\`json\n`;
    md += JSON.stringify({ smithy: "2.0", shapes: shapesInPartition }, null, 2);
    md += `\n\`\`\`\n\n</details>\n`;
    
    return md;
  }

  // Extract docs if option is provided
  if (extractDocsDir) {
    console.log(`Extracting initial docs to ${extractDocsDir}...`);
    await fs.mkdir(extractDocsDir, { recursive: true });

    // Build shape partition map
    const commonShapes: Record<string, any> = {};
    const operationShapes: Record<string, Record<string, any>> = {};
    
    for (const opName of requiredOperations) {
      operationShapes[opName] = {};
    }

    // Assign service shape to common partition
    commonShapes['com.amazonaws.s3#AmazonS3'] = JSON.parse(JSON.stringify(ast.shapes['com.amazonaws.s3#AmazonS3']));

    // Build set of operation-specific shape IDs: operation shape itself, input shape, and output shape
    const opSpecificShapeIds = new Set<string>();
    for (const opName of requiredOperations) {
      const opId = `com.amazonaws.s3#${opName}`;
      const opDef = ast.shapes[opId];
      if (opDef) {
        opSpecificShapeIds.add(opId);
        if (opDef.input?.target) opSpecificShapeIds.add(opDef.input.target);
        if (opDef.output?.target) opSpecificShapeIds.add(opDef.output.target);
      }
    }

    // Deep copy shapes for partitioning
    for (const [shapeId, shapeDef] of Object.entries<any>(ast.shapes)) {
      if (shapeId === 'com.amazonaws.s3#AmazonS3') continue;
      
      const shapeCopy = JSON.parse(JSON.stringify(shapeDef));
      if (opSpecificShapeIds.has(shapeId)) {
        let opName = '';
        if (shapeDef.type === 'operation') {
          opName = shapeId.split('#')[1] || '';
        } else {
          for (const name of requiredOperations) {
            const opId = `com.amazonaws.s3#${name}`;
            const opDef = ast.shapes[opId];
            if (opDef && (opDef.input?.target === shapeId || opDef.output?.target === shapeId)) {
              opName = name;
              break;
            }
          }
        }
        if (opName && operationShapes[opName]) {
          operationShapes[opName]![shapeId] = shapeCopy;
        } else {
          commonShapes[shapeId] = shapeCopy;
        }
      } else {
        commonShapes[shapeId] = shapeCopy;
      }
    }

    // Write index.md
    const indexMdPath = path.join(extractDocsDir, 'index.md');
    if (!existsSync(indexMdPath) || options.force) {
      const isOverwrite = existsSync(indexMdPath);
      const indexMd = generateIndexMarkdown();
      await fs.writeFile(indexMdPath, convertToGfmAlerts(indexMd), 'utf-8');
      console.log(`${isOverwrite ? 'Overwrote' : 'Extracted'}: index.md`);
    } else {
      console.log(`Skipping extraction for index.md (file already exists).`);
    }

    // Write shared-shapes.md
    const sharedShapesMdPath = path.join(extractDocsDir, 'shared-shapes.md');
    if (!existsSync(sharedShapesMdPath) || options.force) {
      const isOverwrite = existsSync(sharedShapesMdPath);
      const sharedShapesMd = generateSharedShapesMarkdown(commonShapes, ast);
      await fs.writeFile(sharedShapesMdPath, convertToGfmAlerts(sharedShapesMd), 'utf-8');
      console.log(`${isOverwrite ? 'Overwrote' : 'Extracted'}: shared-shapes.md`);
    } else {
      console.log(`Skipping extraction for shared-shapes.md (file already exists).`);
    }

    // Write operation markdown files
    for (const opName of requiredOperations) {
      const opId = `com.amazonaws.s3#${opName}`;
      const opDef = ast.shapes[opId];
      if (opDef) {
        const mdPath = path.join(extractDocsDir, `${opName}.md`);
        if (existsSync(mdPath) && !options.force) {
          console.log(`Skipping extraction for ${opName}.md (file already exists).`);
        } else {
          const isOverwrite = existsSync(mdPath);
          const opMd = generateOperationMarkdown(opName, opId, opDef, operationShapes[opName], ast);
          await fs.writeFile(mdPath, convertToGfmAlerts(opMd), 'utf-8');
          console.log(`${isOverwrite ? 'Overwrote' : 'Extracted'}: ${opName}.md`);
        }
      }
    }
  }

  // Stripping examples traits in baseline AST to make bare AST
  if (!options['keep-docs']) {
    console.log('Stripping examples traits to make bare AST...');
    for (const [shapeId, shapeDef] of Object.entries<any>(ast.shapes)) {
      if (shapeDef.traits) {
        delete shapeDef.traits['smithy.api#examples'];
      }
      if (shapeDef.members) {
        for (const memberDef of Object.values<any>(shapeDef.members)) {
          if (memberDef.traits) {
            delete memberDef.traits['smithy.api#examples'];
          }
        }
      }
    }
  } else {
    console.log('Keeping original AWS documentation and examples in the output AST (--keep-docs).');
  }

  console.log(`Filtered from ${originalOperations.length} to ${filteredOperations.length} operations.`);
  
  await fs.writeFile(baselineModelPath, JSON.stringify(ast, null, 2));
  console.log(`Saved bare baseline model to ${baselineModelPath}`);
}

