/**
 * 根据 src/engine/augments.ts 生成 README 中的锦囊表，并替换 README 里
 * <!-- augments:start --> 与 <!-- augments:end --> 之间的内容。
 *
 *   npm run docs:augments
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { AUGMENT_LIST, TIER_NAMES, type Tier } from '../src/engine'

const tiers: Tier[] = ['silver', 'gold', 'prism']
const table = tiers
  .map((t) => {
    const rows = AUGMENT_LIST.filter((a) => a.tier === t).map((a) => `| ${a.glyph} | **${a.name}** | ${a.desc} |`)
    return [`### ${TIER_NAMES[t]}（${rows.length}）`, '', '| | 名称 | 效果 |', '|---|---|---|', ...rows].join('\n')
  })
  .join('\n\n')

const path = new URL('../README.md', import.meta.url)
const readme = readFileSync(path, 'utf8')
const start = '<!-- augments:start -->'
const end = '<!-- augments:end -->'
const i = readme.indexOf(start)
const j = readme.indexOf(end)
if (i < 0 || j < 0) throw new Error('README 中缺少锦囊表标记')
writeFileSync(path, `${readme.slice(0, i + start.length)}\n\n${table}\n\n${readme.slice(j)}`)
console.log(`已更新 README 锦囊表：共 ${AUGMENT_LIST.length} 个`)
