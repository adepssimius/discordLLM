# discordllm-bot

A Helm chart that runs one bot built on [discordllm](../../README.md): a single
pod, its settings, its secrets, and the volume it keeps everything on.

```bash
helm install mybot oci://ghcr.io/adepssimius/charts/discordllm-bot --version <version> -n bots -f values.yaml
```

The release name names everything: a release called `mybot` makes a Deployment
`mybot`, a ConfigMap `mybot-config` and a claim `mybot-data`.

## Values

The ones that matter. [`values.yaml`](values.yaml) has the rest, with comments.

| Value | |
| --- | --- |
| `image.repository`, `image.tag` | The bot's own image, as `discordllm-build` names it. Both required. |
| `config` | Settings that are not secret, as environment variables. A change restarts the pod. |
| `secrets`, `envFromSecrets`, `secretEnv` | The bot's secrets, three ways. See [Secrets](#secrets). |
| `extraObjects` | Extra manifests installed with the release, templated. |
| `persistence.size`, `storageClass` | The claim the chart creates. Kept when the release is uninstalled. |
| `persistence.existingClaim` | Use a claim that already exists and create none. |
| `persistence.name` | The created claim's name, when `<release>-data` will not do. |
| `resources` | Requests and a memory limit. No CPU limit by default. |
| `service.enabled` | A Service on the health port. Off: nothing needs to reach the bot. |

Two things are fixed on purpose. There is always one replica, because two pods
on one Discord token would both answer every message. And a rollout stops the
old pod before starting the new one, so the volume and the Discord connection
are free.

`DATA_DIR`, `HOME` and `HTTP_PORT` are set for you from `persistence.mountPath`
and `httpPort`.

## Secrets

Every bot needs two, and usually one or more of its own:

| Variable | |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The bot's own Discord application token. |
| `CLAUDE_CODE_OAUTH_TOKEN` | For the default Claude backend: a subscription token from `claude setup-token`. Or `ANTHROPIC_API_KEY`. |
| the bot's own | Whatever its MCP servers need, e.g. `HOMEBOX_TOKEN`. The bot's README lists them. |
| `DATABASE_URL` | Only with Postgres. |

The chart does not assume any secret manager. Pick whichever of these fits the
cluster; they can be combined.

**The chart creates the Secret.** The simplest, and enough for a single
`helm install`. The values become part of the release, so keep them out of
plain git: pass them on the command line, or from a values file that is
encrypted (sops, helm-secrets) or written by your pipeline.

```bash
helm install mybot oci://ghcr.io/adepssimius/charts/discordllm-bot -n bots -f values.yaml \
  --set secrets.DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN" \
  --set secrets.CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"
```

**A Secret you made, keyed by variable name.** Every key is loaded.

```bash
kubectl -n bots create secret generic mybot-env \
  --from-literal=DISCORD_BOT_TOKEN=... --from-literal=CLAUDE_CODE_OAUTH_TOKEN=...
```

```yaml
envFromSecrets: [mybot-env]
```

**A Secret whose keys are not variable names.** Map each one.

```yaml
secretEnv:
  DISCORD_BOT_TOKEN: { secret: mybot-secrets, key: discord-bot-token }
```

**A secret operator.** External Secrets, Sealed Secrets, the 1Password
operator and the like all end in an ordinary Secret, so they use one of the
two forms above. `extraObjects` lets the operator's own object ship with the
release:

```yaml
envFromSecrets: [mybot-env]
extraObjects:
  - apiVersion: external-secrets.io/v1
    kind: ExternalSecret
    metadata:
      name: mybot-env
    spec:
      secretStoreRef: { name: my-store, kind: ClusterSecretStore }
      target: { name: mybot-env }
      dataFrom:
        - extract: { key: bots/mybot }
```

A Secret or key that does not exist is not caught at install: the pod stays in
`CreateContainerConfigError` and `kubectl describe pod` names what is missing.
A change to a Secret the chart did not create does not restart the pod.

## With Flux

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: discordllm-bot
  namespace: flux-system
spec:
  interval: 1h
  url: oci://ghcr.io/adepssimius/charts/discordllm-bot
  ref:
    semver: "0.x"
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: mybot
  namespace: bots
spec:
  interval: 10m
  chartRef:
    kind: OCIRepository
    name: discordllm-bot
    namespace: flux-system
  values:
    image:
      repository: ghcr.io/you/mybot
      tag: main-12-abc1234 # {"$imagepolicy": "flux-system:mybot:tag"}
    config:
      DISCORD_GUILD_ID: "123456789012345678"
```

Image automation works as it does on a plain Deployment. The `ImageRepository`,
`ImagePolicy` and `ImageUpdateAutomation` are unchanged; the setter marker goes
on the `tag` line, with `:tag` after the policy's name so only the tag is
written.
