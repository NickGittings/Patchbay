/** Whether `value` is a full commit id (SHA-1 or SHA-256), not a branch name. */
export const isCommitId = (value: string) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)

/** The abbreviated form of a commit id shown in the UI. */
export const shortSha = (commit: string) => commit.slice(0, 7)
