import {
  hashPassword,
  normalizeUsername,
  validatePassword,
} from './services/account'
import {
  storeGetAccountByUsername,
  storeListAccounts,
  storeSetAccountDisabled,
  storeUpdateAccountPassword,
} from './store'
import { closeDatabase } from './db/database'

async function readMasked(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const input = await Bun.stdin.text()
    process.stdout.write('\n')
    return input.replace(/[\r\n]+$/, '')
  }

  return new Promise((resolve, reject) => {
    let value = ''
    const finish = () => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.off('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString()
      for (const character of text) {
        if (character === '\u0003') {
          process.stdin.setRawMode(false)
          process.stdin.off('data', onData)
          reject(new Error('Cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += character
      }
    }
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

function usage(): never {
  console.error(
    'Usage: bun run dist/admin.js <list-users|disable-user|reset-password> [username]',
  )
  process.exit(2)
}

async function main() {
  const [command, usernameArgument, ...extra] = process.argv.slice(2)
  if (extra.length > 0) usage()

  if (command === 'list-users') {
    if (usernameArgument) usage()
    for (const account of storeListAccounts()) {
      console.log(
        `${account.username}\t${account.id}\t${account.disabledAt ? 'disabled' : 'active'}`,
      )
    }
    return
  }

  const username = normalizeUsername(usernameArgument)
  if (!username) usage()
  const account = storeGetAccountByUsername(username)
  if (!account) throw new Error('User not found')

  if (command === 'disable-user') {
    if (!storeSetAccountDisabled(account.id, true)) {
      throw new Error('Unable to disable user')
    }
    console.log(`Disabled ${account.username}`)
    return
  }

  if (command === 'reset-password') {
    const password = await readMasked('New password: ')
    const confirmation = await readMasked('Confirm password: ')
    if (password !== confirmation) throw new Error('Passwords do not match')
    if (!validatePassword(password)) {
      throw new Error('Password must be 12-128 characters')
    }
    const passwordHash = await hashPassword(password)
    if (!storeUpdateAccountPassword(account.id, passwordHash)) {
      throw new Error('Unable to reset password')
    }
    console.log(`Password reset for ${account.username}`)
    return
  }

  usage()
}

try {
  await main()
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  closeDatabase()
}
