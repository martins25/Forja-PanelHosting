package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/m4rtins/forja/agent/internal/health"
	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type SiteDeploy struct {
	OS       osutil.OSExecutor
	Health   health.Checker
	BasePath string // override accountsBase in tests
}

type SiteDeployParams struct {
	AccountSlug    string `json:"account_slug"`
	Domain         string `json:"domain"`
	Runtime        string `json:"runtime"`
	RuntimeVersion string `json:"runtime_version"`
	Repo           string `json:"repo"`
	Branch         string `json:"branch"`
	Commit         string `json:"commit"`
	InstallCmd     string `json:"install_cmd"`
	BuildCmd       string `json:"build_cmd"`
	StartCmd       string `json:"start_cmd"`
	PublicDir      string `json:"public_dir"`
	TargetPort     int               `json:"target_port"`
	OldContainer   string            `json:"old_container"`
	CPUMillis      int               `json:"cpu_millis"`
	MemoryMB       int               `json:"memory_mb"`
	EnvVars        map[string]string `json:"env_vars"`
}

type SiteDeployResult struct {
	ContainerName string `json:"container_name"`
	Image         string `json:"image"`
	CommitSHA     string `json:"commit_sha"`
	ActivePort    int    `json:"active_port"`
	LogPath       string `json:"log_path"`
}

func (a *SiteDeploy) Name() string { return "site.deploy" }

func (a *SiteDeploy) Validate(params json.RawMessage) error {
	var p SiteDeployParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.Hostname(p.Domain); err != nil {
		return err
	}
	if err := validate.RuntimeVersion(p.Runtime, p.RuntimeVersion); err != nil {
		return err
	}
	if err := validate.RepoURL(p.Repo); err != nil {
		return err
	}
	if err := validate.GitBranch(p.Branch); err != nil {
		return err
	}
	if err := validate.CommitSHA(p.Commit); err != nil {
		return err
	}
	if err := validate.ContainerCmd(p.InstallCmd); err != nil {
		return err
	}
	if err := validate.ContainerCmd(p.BuildCmd); err != nil {
		return err
	}
	if err := validate.ContainerCmd(p.StartCmd); err != nil {
		return err
	}
	if err := validate.PublicDir(p.PublicDir); err != nil {
		return err
	}
	if err := validate.ContainerName(p.OldContainer); err != nil {
		return err
	}
	if err := validate.Port(p.TargetPort); err != nil {
		return err
	}
	if p.CPUMillis < 100 || p.CPUMillis > 16000 {
		return fmt.Errorf("%w: cpu_millis must be 100-16000", validate.ErrInvalid)
	}
	if p.MemoryMB < 64 || p.MemoryMB > 65536 {
		return fmt.Errorf("%w: memory_mb must be 64-65536", validate.ErrInvalid)
	}
	for k, v := range p.EnvVars {
		if err := validate.EnvKey(k); err != nil {
			return err
		}
		if err := validate.EnvValue(v); err != nil {
			return err
		}
	}
	return nil
}

func (a *SiteDeploy) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p SiteDeployParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)
	siteDir := filepath.Join(homeDir, "sites", p.Domain)
	appDir := filepath.Join(siteDir, "app")
	domSafe := validate.DomainSafe(p.Domain)

	commitTag := p.Commit
	if len(commitTag) > 7 {
		commitTag = commitTag[:7]
	}
	imageName := fmt.Sprintf("localhost/fj-%s-%s:%s", p.AccountSlug, domSafe, commitTag)

	slot := "blue"
	if p.TargetPort%2 != 0 {
		slot = "green"
	}
	containerName := fmt.Sprintf("fj-%s-%s-%s", p.AccountSlug, domSafe, slot)

	uid, _, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("account user not found: %w", err)
	}

	// The account owns sites/<domain> and could have replaced it with a symlink
	// to anywhere. Everything below that root writes into it must stay in the home.
	if err := requireRealDirInHome(homeDir, siteDir); err != nil {
		return nil, fmt.Errorf("site directory: %w", err)
	}

	var buildLog strings.Builder
	logStep := func(label string, out []byte, err error) {
		fmt.Fprintf(&buildLog, "=== %s ===\n", label)
		if len(out) > 0 {
			buildLog.Write(out)
			if out[len(out)-1] != '\n' {
				buildLog.WriteByte('\n')
			}
		}
		if err != nil {
			fmt.Fprintf(&buildLog, "ERROR: %v\n", err)
		}
	}

	// 1. Clone or fetch the repository
	_, err = a.OS.ReadFile(filepath.Join(appDir, ".git", "HEAD"))
	if err != nil {
		out, err := a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/git", "clone",
			"--depth", "1",
			"--branch", p.Branch,
			p.Repo, appDir,
		)
		logStep("git clone", out, err)
		if err != nil {
			return nil, fmt.Errorf("git clone failed: %w", err)
		}
	} else {
		out, err := a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/git", "-C", appDir,
			"fetch", "origin", p.Branch,
		)
		logStep("git fetch", out, err)
		if err != nil {
			return nil, fmt.Errorf("git fetch failed: %w", err)
		}
		out, err = a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/git", "-C", appDir,
			"checkout", p.Commit,
		)
		logStep("git checkout", out, err)
		if err != nil {
			return nil, fmt.Errorf("git checkout failed: %w", err)
		}
	}

	// 2. Resolve Containerfile path
	var containerfilePath string
	if p.Runtime == "docker" {
		containerfilePath = filepath.Join(appDir, "Dockerfile")
	} else {
		containerfile := generateContainerfile(p)
		containerfilePath = filepath.Join(siteDir, "Containerfile")
		if err := writeFileInHome(ctx, a.OS, homeDir, containerfilePath, []byte(containerfile), 0644, uid, 0); err != nil {
			return nil, fmt.Errorf("write Containerfile: %w", err)
		}
	}

	// 3. Build image
	out, err := a.OS.RunAs(ctx, linuxUser,
		"/usr/bin/podman", "build",
		"--tag", imageName,
		"--file", containerfilePath,
		appDir,
	)
	logStep("podman build", out, err)
	if err != nil {
		return nil, fmt.Errorf("podman build failed: %w", err)
	}

	// 4. Write env file
	envFilePath := filepath.Join(siteDir, ".env")
	envContent := buildEnvFile(p.Runtime, p.TargetPort, p.EnvVars)
	if err := writeFileInHome(ctx, a.OS, homeDir, envFilePath, []byte(envContent), 0600, uid, 0); err != nil {
		return nil, fmt.Errorf("write env file: %w", err)
	}

	// 5. Stop+rm same-slot container (may not exist)
	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "10", "--", containerName)
	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "--", containerName)

	// 6. Start new container
	cPort := containerPort(p.Runtime, p.TargetPort)
	out, err = a.OS.RunAs(ctx, linuxUser,
		"/usr/bin/podman", "run",
		"--detach",
		"--name", containerName,
		"--publish", fmt.Sprintf("127.0.0.1:%d:%d", p.TargetPort, cPort),
		"--network", "fj-"+p.AccountSlug,
		"--memory", fmt.Sprintf("%dm", p.MemoryMB),
		"--cpus", fmt.Sprintf("%.1f", float64(p.CPUMillis)/1000.0),
		"--pids-limit", "256",
		"--restart", "on-failure:3",
		"--env-file", envFilePath,
		"--volume", filepath.Join(siteDir, "storage")+":/app/storage:Z",
		imageName,
	)
	logStep("podman run", out, err)
	if err != nil {
		return nil, fmt.Errorf("podman run failed: %w", err)
	}

	// 7. Healthcheck
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/", p.TargetPort)
	if err := a.Health.Check(ctx, healthURL); err != nil {
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "5", "--", containerName)
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "--", containerName)
		return nil, fmt.Errorf("healthcheck failed: %w", err)
	}

	// 8. Stop old container (other slot)
	if p.OldContainer != "" {
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "30", "--", p.OldContainer)
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "--", p.OldContainer)
	}

	// 9. Write build log
	// Best effort: the deploy already succeeded, so a refused log write does not
	// fail it, but nothing is written through links planted by the account.
	logsDir := filepath.Join(siteDir, "logs")
	logFileName := fmt.Sprintf("deploy-%s.log", time.Now().UTC().Format("20060102-150405"))
	logPath := filepath.Join(logsDir, logFileName)
	if err := requireRealDirInHome(homeDir, logsDir); err != nil {
		logPath = ""
	} else if err := a.OS.EnsureDir(logsDir, 0750, uid, 0); err != nil {
		logPath = ""
	} else if err := writeFileInHome(ctx, a.OS, homeDir, logPath, []byte(buildLog.String()), 0640, uid, 0); err != nil {
		logPath = ""
	}

	return &SiteDeployResult{
		ContainerName: containerName,
		Image:         imageName,
		CommitSHA:     p.Commit,
		ActivePort:    p.TargetPort,
		LogPath:       logPath,
	}, nil
}

func containerPort(runtime string, targetPort int) int {
	switch runtime {
	case "php":
		return 8080
	case "python":
		return 8000
	case "static":
		return 80
	case "docker":
		return targetPort
	default:
		return 3000
	}
}

func buildEnvFile(runtime string, targetPort int, userVars map[string]string) string {
	var b strings.Builder
	switch runtime {
	case "node":
		b.WriteString("NODE_ENV=production\n")
		b.WriteString("PORT=3000\n")
	case "php":
		b.WriteString("PORT=8080\n")
	case "python":
		b.WriteString("PORT=8000\n")
	case "docker":
		fmt.Fprintf(&b, "PORT=%d\n", targetPort)
	}
	keys := make([]string, 0, len(userVars))
	for k := range userVars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%s\n", k, userVars[k])
	}
	return b.String()
}

func generateContainerfile(p SiteDeployParams) string {
	switch p.Runtime {
	case "php":
		return generatePHPContainerfile(p)
	case "python":
		return generatePythonContainerfile(p)
	case "static":
		return generateStaticContainerfile(p)
	default:
		return generateNodeContainerfile(p)
	}
}

func generateNodeContainerfile(p SiteDeployParams) string {
	installCmd := p.InstallCmd
	if installCmd == "" {
		installCmd = "npm ci"
	}
	startCmd := p.StartCmd
	if startCmd == "" {
		startCmd = "npm start"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "FROM docker.io/library/node:%s-alpine\n\n", p.RuntimeVersion)
	b.WriteString("WORKDIR /app\n\n")
	b.WriteString("COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./\n")
	fmt.Fprintf(&b, "RUN %s\n\n", installCmd)
	b.WriteString("COPY . .\n")
	if p.BuildCmd != "" {
		fmt.Fprintf(&b, "RUN %s\n", p.BuildCmd)
	}
	b.WriteString("\nENV NODE_ENV=production\n")
	b.WriteString("ENV PORT=3000\n")
	b.WriteString("EXPOSE 3000\n\n")
	fmt.Fprintf(&b, "CMD %s\n", startCmd)
	return b.String()
}

func generatePHPContainerfile(p SiteDeployParams) string {
	installCmd := p.InstallCmd
	publicDir := p.PublicDir
	if publicDir == "" {
		publicDir = "public"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "FROM docker.io/library/php:%s-cli-alpine\n\n", p.RuntimeVersion)
	b.WriteString("WORKDIR /app\n\n")
	b.WriteString("COPY . .\n")
	if installCmd != "" {
		fmt.Fprintf(&b, "RUN %s\n\n", installCmd)
	}
	b.WriteString("ENV PORT=8080\n")
	b.WriteString("EXPOSE 8080\n\n")
	fmt.Fprintf(&b, "CMD php -S 0.0.0.0:8080 -t %s\n", publicDir)
	return b.String()
}

func generatePythonContainerfile(p SiteDeployParams) string {
	installCmd := p.InstallCmd
	if installCmd == "" {
		installCmd = "pip install --no-cache-dir -r requirements.txt"
	}
	startCmd := p.StartCmd
	if startCmd == "" {
		startCmd = "gunicorn app:app -b 0.0.0.0:8000"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "FROM docker.io/library/python:%s-slim\n\n", p.RuntimeVersion)
	b.WriteString("WORKDIR /app\n\n")
	b.WriteString("COPY requirements.txt* ./\n")
	fmt.Fprintf(&b, "RUN %s\n\n", installCmd)
	b.WriteString("COPY . .\n")
	if p.BuildCmd != "" {
		fmt.Fprintf(&b, "RUN %s\n", p.BuildCmd)
	}
	b.WriteString("\nENV PORT=8000\n")
	b.WriteString("EXPOSE 8000\n\n")
	fmt.Fprintf(&b, "CMD %s\n", startCmd)
	return b.String()
}

func generateStaticContainerfile(p SiteDeployParams) string {
	publicDir := p.PublicDir
	if publicDir == "" {
		publicDir = "public"
	}

	var b strings.Builder
	if p.BuildCmd != "" {
		b.WriteString("FROM docker.io/library/node:22-alpine AS build\n\n")
		b.WriteString("WORKDIR /app\n\n")
		b.WriteString("COPY . .\n")
		if p.InstallCmd != "" {
			fmt.Fprintf(&b, "RUN %s\n", p.InstallCmd)
		}
		fmt.Fprintf(&b, "RUN %s\n\n", p.BuildCmd)
		b.WriteString("FROM docker.io/library/caddy:2-alpine\n")
		fmt.Fprintf(&b, "COPY --from=build /app/%s /srv\n", publicDir)
	} else {
		b.WriteString("FROM docker.io/library/caddy:2-alpine\n\n")
		fmt.Fprintf(&b, "COPY %s /srv\n", publicDir)
	}
	b.WriteString("EXPOSE 80\n\n")
	b.WriteString("CMD [\"caddy\", \"file-server\", \"--root\", \"/srv\", \"--listen\", \":80\"]\n")
	return b.String()
}
