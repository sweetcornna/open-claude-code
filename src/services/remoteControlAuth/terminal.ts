import * as readline from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { authenticateRemoteControl } from './index.js'
import { RemoteControlAuthError } from './types.js'

async function promptLine(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    return await input.question(prompt)
  } catch {
    return null
  } finally {
    input.close()
  }
}

async function promptPassword(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  const input = process.stdin
  const output = process.stdout
  const wasRaw = input.isRaw
  readline.emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  output.write(prompt)

  return new Promise(resolve => {
    let value = ''
    const finish = (result: string | null): void => {
      input.off('keypress', onKeypress)
      input.setRawMode(wasRaw)
      output.write('\n')
      resolve(result)
    }
    const onKeypress = (sequence: string, key: readline.Key): void => {
      if (key.ctrl && key.name === 'c') {
        finish(null)
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish(value)
        return
      }
      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = [...value].slice(0, -1).join('')
          output.write('\b \b')
        }
        return
      }
      if (key.ctrl || key.meta || key.name === 'escape' || !sequence) return
      value += sequence
      output.write('*'.repeat([...sequence].length))
    }
    input.on('keypress', onKeypress)
  })
}

export async function promptForRemoteControlAuthentication(
  baseUrl: string,
  registrationEnabled: boolean,
): Promise<boolean> {
  const actionInput = registrationEnabled
    ? await promptLine('Remote Control action [login/register] (login): ')
    : 'login'
  if (actionInput === null) return false
  const normalizedAction = actionInput.trim().toLowerCase()
  const action = normalizedAction === 'register' ? 'register' : 'login'
  if (action === 'register' && !registrationEnabled) {
    process.stderr.write(
      'Remote Control registration is disabled on this server.\n',
    )
    return false
  }

  const username = await promptLine('Username: ')
  if (username === null) return false
  const password = await promptPassword('Password: ')
  if (password === null) return false

  try {
    const user = await authenticateRemoteControl(
      baseUrl,
      action,
      username,
      password,
    )
    process.stderr.write(`Remote Control logged in as ${user.username}.\n`)
    return true
  } catch (error) {
    if (error instanceof RemoteControlAuthError) {
      const retry = error.retryAfterSeconds
      process.stderr.write(
        `${error.message}${retry === undefined ? '' : ` Try again in ${retry}s.`}\n`,
      )
    } else {
      process.stderr.write(
        'Unable to authenticate with the Remote Control server.\n',
      )
    }
    return false
  }
}
