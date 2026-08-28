import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const orig = readFileSync('D:/AI/Tabby/common/auth.py', 'utf-8').replace(/\r\n?/g, '\n')
writeFileSync(join(repoDir, 'resources/tabby/original-auth.py'), orig)

const patched = orig
  .replace(
    /def _format_api_keys\(auth_keys: AuthKeys\) -> str:\n    if isinstance\(auth_keys\.api_key, str\):\n        return auth_keys\.api_key\n    return ", "\.join\(auth_keys\.api_key\)\n\n\n/,
    ''
  )
  .replace(
    `    logger.info(
        f"Your API key is: {_format_api_keys(AUTH_KEYS)}\\n"
        f"Your admin key is: {AUTH_KEYS.admin_key}\\n"
        "If these keys get compromised, make sure to delete api_tokens.yml "
        "and restart the server. Have fun!"
    )`,
    `    api_count = (
        1 if isinstance(AUTH_KEYS.api_key, str) else len(AUTH_KEYS._api_key_set)
    )
    logger.info(
        f"Auth keys loaded from {AUTH_FILE} ({api_count} API key(s), admin key configured). "
        "If keys are compromised, delete api_tokens.yml and restart. Have fun!"
    )`
  )

writeFileSync(join(repoDir, 'resources/tabby/auth.py'), patched)

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
console.log('originalSha256', hash(join(repoDir, 'resources/tabby/original-auth.py')))
console.log('patchedSha256', hash(join(repoDir, 'resources/tabby/auth.py')))
