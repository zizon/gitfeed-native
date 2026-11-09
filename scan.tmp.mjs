import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.tsx?$/.test(full)) files.push(full)
  }
}
walk('src')

const findings = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  function visit(node) {
    const fnKinds = [ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration]
    if (fnKinds.includes(node.kind)) {
      const body = node.body
      const isAsync = (node.modifiers || []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      const returnsPromise = node.type && /Promise</.test(node.type.getText(sf))
      if (body && ts.isBlock(body) && (isAsync || returnsPromise)) {
        if (body.statements.length === 1 && ts.isReturnStatement(body.statements[0]) && body.statements[0].expression) {
          const expr = body.statements[0].expression
          const awaited = ts.isAwaitExpression(expr)
          const inner = awaited ? expr.expression : expr
          if (ts.isCallExpression(inner)) {
            findings.push(`${(awaited ? 'return-await' : 'return-call').padEnd(16)} ${file}:${lineOf(node)}  ${node.getText(sf).split('\n')[0].slice(0, 100)}`)
          }
        }
      }
    }
    if (ts.isTryStatement(node) && node.catchClause) {
      const stmts = node.catchClause.block.statements
      if (stmts.length === 1 && ts.isThrowStatement(stmts[0])) {
        findings.push(`${'catch-rethrow'.padEnd(16)} ${file}:${lineOf(node)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
}
console.log(findings.join('\n'))
console.log(`${findings.length} findings`)
