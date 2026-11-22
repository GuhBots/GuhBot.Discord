# Glossary

Define shared terms, acronyms, and abbreviations here when a reader could need an explanation. Use one entry per term and keep each table alphabetically ordered. Explain component-specific terms beside that component unless they are useful across the repository.

Add or update definitions when terminology changes, and link to them from other documents when helpful. The acronym check described in [Tools](../tools/README.md) verifies that acronyms used in Markdown are defined here.

## Acronyms and Abbreviations

| Term | Meaning |
| --- | --- |
| AFK | Away from keyboard. The `/afk` command marks a user as away |
| AI | Artificial intelligence |
| AMD | Advanced Micro Devices, a maker of the 64-bit x86 processors used in most desktops, laptops, and servers |
| API | Application programming interface |
| ARM | A processor architecture used by the Raspberry Pi and many small devices |
| CI | Continuous integration |
| CLI | Command-line interface |
| COVID | Coronavirus disease. The original bot had a COVID-19 statistics command |
| CRLF | Carriage return and line feed, the line ending used by Windows |
| ES | ECMAScript, the standard that JavaScript follows. ES modules use `import` and `export` |
| GHCR | GitHub Container Registry, where this repository publishes its images |
| HTTPS | Hypertext Transfer Protocol Secure, the encrypted protocol for websites |
| ID | Identifier |
| LF | Line feed, the line ending used by Linux and macOS |
| LTS | Long-term support, a release maintained for several years |
| OS | Operating system |
| PR | Pull request |
| SD | Secure Digital, a type of memory card |
| SSD | Solid-state drive |
| SSH | Secure Shell, used to log in to another machine's command line |
| USB | Universal Serial Bus |
| VS Code | Visual Studio Code, a code editor |
| WSL | Windows Subsystem for Linux |
| YAML | A configuration file format, used by `compose.yaml` and the GitHub workflows |

## Terms

| Term | Meaning |
| --- | --- |
| Container | A running instance of an image. Containers are replaced when the service is updated, so lasting data belongs in a volume |
| Default branch | The repository's primary integration branch, as configured by its hosting service |
| Derived template | A template that builds on this base with additional conventions, files, or tools |
| Dev container | A container that provides a project's development environment, defined in the `.devcontainer/` directory |
| discordx | The npm package for discord.ts, a framework that defines Discord commands with TypeScript decorators |
| Docker Compose | A tool that runs containers as described in `compose.yaml` |
| Embed | A formatted Discord message card with a title, fields, colours, and images |
| Guild | Discord's internal name for a server |
| Image | A packaged snapshot of an application and everything it needs to run, built from a Dockerfile |
| Intent | A category of Discord events the bot subscribes to. Privileged intents, such as Message Content, must be turned on in the Developer Portal |
| Monorepo | A repository containing multiple projects or components maintained together |
| README | A file that introduces a repository or directory and explains what it contains |
| Registry | A server that stores images for machines to download, such as GHCR |
| Reverse proxy | A server that receives web traffic for several applications and forwards each request by hostname |
| Slash command | A Discord command that users start by typing `/`, with options Discord validates |
| Stack | A set of containers started together from one `compose.yaml`, such as one self-hosted application |
| Volume | Storage managed by Docker that keeps a container's data across updates |
