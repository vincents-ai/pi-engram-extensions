#!/usr/bin/env python3
"""Replace local runEngram/parseUuid with shared import in engram extensions."""
import re
import sys

def replace_local_helpers(filepath):
    with open(filepath) as f:
        content = f.read()
    
    # Check if already uses shared import
    if 'common/runEngram' in content:
        print(f"  SKIP {filepath} — already uses shared import")
        return
    
    # Remove local runEngram function
    content = re.sub(
        r'\nasync function runEngram\s*\([^)]*\)\s*(?::\s*[^{]+)?\{(?:[^{}]|(?:\{[^{}]*\}))*\}',
        '',
        content,
        count=1
    )
    
    # Remove local parseUuid function
    content = re.sub(
        r'\nfunction parseUuid\s*\([^)]*\)\s*(?::\s*[^{]+)?\{[^}]*\}',
        '',
        content
    )
    
    # Remove unused imports if no other execFile/promisify usage
    has_execfile_direct = bool(re.search(r'execFile\(', content.replace('async function runEngram', '').replace('function runEngram', '')))
    
    if not has_execfile_direct:
        content = re.sub(r'import { execFile } from "node:child_process";\n', '', content)
        content = re.sub(r'import { promisify } from "node:util";\n', '', content)
        content = re.sub(r'const execFileAsync = promisify\(execFile\);\n', '', content)
    
    # Add shared import after the last import line
    last_import = max(
        content.rfind('import type '),
        content.rfind('import { Type'),
        content.rfind('import { isToolCall'),
    )
    if last_import == -1:
        last_import = content.find('import ')
    
    insert_pos = content.index('\n', last_import) + 1
    shared_import = 'import { runEngram, parseUuid } from "./common/runEngram.js";\n'
    
    if 'runEngram' not in content[:insert_pos + 200]:  # not already imported
        content = content[:insert_pos] + shared_import + content[insert_pos:]
    
    # Clean up multiple blank lines
    content = re.sub(r'\n{3,}', '\n\n', content)
    
    with open(filepath, 'w') as f:
        f.write(content)
    
    print(f"  DONE {filepath}")

if __name__ == '__main__':
    files = [
        'extensions/engram-commit-gate.ts',
        'extensions/engram-session.ts',
        'extensions/engram-status.ts',
        'extensions/engram-write-first.ts',
    ]
    for f in files:
        replace_local_helpers(f)
