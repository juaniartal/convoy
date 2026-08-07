{{- define "convoy.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "convoy.fullname" -}}
{{- .Release.Name -}}-{{- .Chart.Name -}}
{{- end -}}

{{- define "convoy.labels" -}}
app.kubernetes.io/name: {{ include "convoy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "convoy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "convoy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
