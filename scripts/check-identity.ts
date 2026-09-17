import { command, isMain, runCli } from "./cli.ts";

export const expectedLogin = "yukurash";
export const expectedIdentity =
  "yukurash <152368380+yukurash@users.noreply.github.com>";

export function assertIdentity(
  login: string,
  author: string,
  committer: string,
  remote: string,
): void {
  if (login.trim() !== expectedLogin) {
    throw new Error("GitHub authentication is not yukurash.");
  }
  for (const [label, identity] of [["author", author], ["committer", committer]]) {
    const match = /^(.*) \d+ [+-]\d{4}$/.exec(identity ?? "");
    if (match?.[1] !== expectedIdentity) {
      throw new Error(`Git ${label} identity does not match yukurash.`);
    }
  }
  if (!/^https:\/\/github\.com\/yukurash\/voice-action-lab(?:\.git)?$/.test(remote)) {
    throw new Error("Push remote is not the expected yukurash HTTPS repository.");
  }
}

export function verifyIdentity(): void {
  assertIdentity(
    command("gh", ["api", "user", "--jq", ".login"]),
    command("git", ["var", "GIT_AUTHOR_IDENT"]),
    command("git", ["var", "GIT_COMMITTER_IDENT"]),
    command("git", ["remote", "get-url", "--push", "origin"]),
  );
  console.log("GitHub login, Git identities, and push remote match yukurash.");
}

if (isMain(import.meta.url)) runCli(verifyIdentity);
