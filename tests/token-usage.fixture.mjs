export const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export function session(id, overrides = {}) {
  return {
    id, title: id, projectID: "project", cost: 0, tokens: zeroTokens,
    time: { created: 1, updated: 1 }, location: { directory: "/project" },
    ...overrides,
  }
}

export function assistant(id, created, tokens = zeroTokens, model = { providerID: "openai", id: "gpt-4o" }) {
  return { id, type: "assistant", time: { created }, agent: "build", model, content: [], tokens }
}

export function nativeClient({ sessions = [], messages = {}, pageSize = 1 } = {}) {
  const calls = []
  function page(records, cursor) {
    const offset = Number(cursor ?? 0)
    const end = offset + pageSize
    return { data: records.slice(offset, end), cursor: end < records.length ? { next: String(end) } : {} }
  }
  return {
    calls,
    session: {
      async list(input, options) {
        calls.push({ method: "session.list", input, options })
        return page(sessions, input.cursor)
      },
      async get(input, options) {
        calls.push({ method: "session.get", input, options })
        const found = sessions.findLast((value) => value.id === input.sessionID)
        if (!found) throw { _tag: "SessionNotFoundError", sessionID: input.sessionID, message: "Missing session" }
        return found
      },
    },
    message: {
      async list(input, options) {
        calls.push({ method: "message.list", input, options })
        return page(messages[input.sessionID] ?? [], input.cursor)
      },
    },
  }
}

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export const tick = () => new Promise((resolve) => setImmediate(resolve))
