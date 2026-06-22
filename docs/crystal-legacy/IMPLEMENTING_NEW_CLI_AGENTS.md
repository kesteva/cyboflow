# Implementing New CLI Agents in Crystal

> **MERGED — see [`ADDING_NEW_CLI_TOOLS.md`](./ADDING_NEW_CLI_TOOLS.md).**
>
> This guide duplicated the parallel "Adding New CLI Tools" guide. The two Crystal-era how-tos
> have been consolidated into a single canonical document to avoid drift. The unique manager
> patterns that used to live only here (suggested file structure, protocol-based manager,
> authentication, tool-call handling) are preserved under
> [**Alternative manager patterns**](./ADDING_NEW_CLI_TOOLS.md#alternative-manager-patterns-merged-from-implementing_new_cli_agents)
> in that document.
>
> As with all `crystal-legacy/` docs, the `AbstractCliManager` extension surface taught there is
> still live in cyboflow, but the removed **Codex** panel examples are no longer real code.
