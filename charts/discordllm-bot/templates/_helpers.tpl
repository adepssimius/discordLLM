{{- define "bot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The release name by default: a release called `mybot` makes a Deployment called `mybot`. */}}
{{- define "bot.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "bot.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "bot.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* The claim the pod mounts: an existing one, or the one this chart creates. */}}
{{- define "bot.claimName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- default (printf "%s-data" (include "bot.fullname" .)) .Values.persistence.name -}}
{{- end -}}
{{- end -}}

{{- define "bot.image" -}}
{{- $repo := required "image.repository is required: the bot's own image, e.g. ghcr.io/you/yourbot" .Values.image.repository -}}
{{- $tag := required "image.tag is required" .Values.image.tag -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
