# singaseongAI

## Local Development

This project now requires an access code before the chat UI is loaded. Configure a
`VITE_ACCESS_KEY` environment variable (for example through a `.env` file when
using Vite or via repository secrets in CI) so the login page can validate the
code. When prompted in the browser, enter the same value to unlock the chat
interface.

For static hosting environments where bundlers cannot inject `import.meta.env`,
set the access code via the rendered HTML. You can expose the secret by wiring
an environment variable to either of the following placeholders:

* `<body data-access-code="%ACCESS_CODE%">`
* `<meta name="access-code" content="%ACCESS_CODE%">`

At build or deploy time, replace `%ACCESS_CODE%` with your environment secret.
Values containing `%PLACEHOLDER%` or `{{PLACEHOLDER}}` are ignored so the login
form will stay locked until a real secret is provided.

If no access code is injected, the login form remains disabled and the chat UI
cannot be loaded. Ensure the deployment pipeline always injects a valid access
code through one of the supported environment placeholders above.
