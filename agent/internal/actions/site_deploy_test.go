package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/health"
	"github.com/m4rtins/forja/agent/internal/osutil"
)

func validDeployParams() SiteDeployParams {
	return SiteDeployParams{
		AccountSlug:    "demo",
		Domain:         "example.com",
		Runtime:        "node",
		RuntimeVersion: "22",
		Repo:           "https://github.com/user/repo",
		Branch:         "main",
		Commit:         "abc1234",
		InstallCmd:     "npm ci",
		BuildCmd:       "npm run build",
		StartCmd:       "node dist/index.js",
		TargetPort:     10000,
		OldContainer:   "",
		CPUMillis:      1000,
		MemoryMB:       512,
	}
}

func TestSiteDeploy_Name(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	if a.Name() != "site.deploy" {
		t.Errorf("expected site.deploy, got %s", a.Name())
	}
}

func TestSiteDeploy_Validate_OK(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	params, _ := json.Marshal(validDeployParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestSiteDeploy_Validate_InvalidRepo(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validDeployParams()
	p.Repo = "https://127.0.0.1/user/repo"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for IP-literal repo host")
	}
}

func TestSiteDeploy_Validate_GiteaRepo(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validDeployParams()
	p.Repo = "https://git.example.com:3000/owner/repo.git"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected Gitea repo to be accepted: %v", err)
	}
}

func TestSiteDeploy_Validate_InvalidCommit(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validDeployParams()
	p.Commit = "XYZ"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid commit SHA")
	}
}

func TestSiteDeploy_Validate_InvalidCmd(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validDeployParams()
	p.InstallCmd = "$(evil)"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for dangerous command")
	}
}

func TestSiteDeploy_Execute_FirstDeploy(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	params, _ := json.Marshal(validDeployParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteDeployResult)
	if r.ContainerName != "fj-demo-example-com-blue" {
		t.Errorf("unexpected container name: %s", r.ContainerName)
	}
	if r.Image != "localhost/fj-demo-example-com:abc1234" {
		t.Errorf("unexpected image: %s", r.Image)
	}
	if r.ActivePort != 10000 {
		t.Errorf("expected port 10000, got %d", r.ActivePort)
	}

	// Should have done git clone (ReadFile fails -> clone path)
	runAsCalls := fake.CallsFor("RunAs")
	foundClone := false
	foundBuild := false
	foundRun := false
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "git clone") {
			foundClone = true
		}
		if strings.Contains(args, "podman build") {
			foundBuild = true
		}
		if strings.Contains(args, "podman run") {
			foundRun = true
			if !strings.Contains(args, "--pids-limit 256") {
				t.Errorf("site podman run missing --pids-limit 256: %s", args)
			}
		}
	}
	if !foundClone {
		t.Error("expected git clone on first deploy")
	}
	if !foundBuild {
		t.Error("expected podman build")
	}
	if !foundRun {
		t.Error("expected podman run")
	}

	// Containerfile should have been written
	cfPath := "/srv/forja/accounts/demo/sites/example.com/Containerfile"
	wfCalls := fake.CallsFor("WriteFileAtomic")
	foundCF := false
	for _, c := range wfCalls {
		if len(c.Args) > 0 && c.Args[0] == cfPath {
			foundCF = true
		}
	}
	if !foundCF {
		t.Error("expected Containerfile to be written")
	}
	cfContent := string(fake.WriteFileData[cfPath])
	if !strings.Contains(cfContent, "node:22-alpine") {
		t.Errorf("Containerfile should reference node:22-alpine, got:\n%s", cfContent)
	}

	// Env file should have been written with system vars
	envPath := "/srv/forja/accounts/demo/sites/example.com/.env"
	envContent := string(fake.WriteFileData[envPath])
	if !strings.Contains(envContent, "NODE_ENV=production") {
		t.Error("env file should contain NODE_ENV=production")
	}
	if !strings.Contains(envContent, "PORT=3000") {
		t.Error("env file should contain PORT=3000")
	}

	// podman run should use --env-file
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman run") {
			if !strings.Contains(args, "--env-file") {
				t.Error("podman run should use --env-file")
			}
			if strings.Contains(args, "--env NODE_ENV") {
				t.Error("podman run should NOT use --env with env-file")
			}
		}
	}

	// Build log should have been written
	if r.LogPath == "" {
		t.Error("expected log_path in result")
	}
	logContent := string(fake.WriteFileData[r.LogPath])
	if !strings.Contains(logContent, "=== git clone ===") {
		t.Error("build log should contain git clone step")
	}
}

func TestSiteDeploy_Execute_SubsequentDeploy(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.ReadFileData["/srv/forja/accounts/demo/sites/example.com/app/.git/HEAD"] = []byte("ref: refs/heads/main\n")
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	p := validDeployParams()
	p.TargetPort = 10001
	p.OldContainer = "fj-demo-example-com-blue"
	params, _ := json.Marshal(p)

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteDeployResult)
	if r.ContainerName != "fj-demo-example-com-green" {
		t.Errorf("expected green slot, got: %s", r.ContainerName)
	}
	if r.ActivePort != 10001 {
		t.Errorf("expected port 10001, got %d", r.ActivePort)
	}

	runAsCalls := fake.CallsFor("RunAs")
	foundFetch := false
	foundCheckout := false
	foundOldStop := false
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "git") && strings.Contains(args, "fetch") {
			foundFetch = true
		}
		if strings.Contains(args, "git") && strings.Contains(args, "checkout") {
			foundCheckout = true
		}
		if strings.Contains(args, "podman stop") && strings.Contains(args, "fj-demo-example-com-blue") {
			foundOldStop = true
		}
	}
	if !foundFetch {
		t.Error("expected git fetch on subsequent deploy")
	}
	if !foundCheckout {
		t.Error("expected git checkout on subsequent deploy")
	}
	if !foundOldStop {
		t.Error("expected old container stop")
	}
}

func TestSiteDeploy_Execute_HealthcheckFails(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	hc := &health.FakeChecker{Err: fmt.Errorf("connection refused")}
	a := &SiteDeploy{OS: fake, Health: hc}

	params, _ := json.Marshal(validDeployParams())
	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error when healthcheck fails")
	}
	if !strings.Contains(err.Error(), "healthcheck failed") {
		t.Errorf("expected healthcheck error, got: %v", err)
	}

	// Should have cleaned up the new container
	runAsCalls := fake.CallsFor("RunAs")
	foundCleanupStop := false
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman stop") && strings.Contains(args, "--time 5") {
			foundCleanupStop = true
		}
	}
	if !foundCleanupStop {
		t.Error("expected cleanup stop of new container after healthcheck failure")
	}
}

func TestSiteDeploy_Execute_BuildFails(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
			allArgs := append([]string{name}, args...)
			full := strings.Join(allArgs, " ")
			if strings.Contains(full, "podman build") {
				return nil, fmt.Errorf("build error: exit 1")
			}
			return nil, nil
		}
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	params, _ := json.Marshal(validDeployParams())
	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error when build fails")
	}
	if !strings.Contains(err.Error(), "podman build failed") {
		t.Errorf("expected build error, got: %v", err)
	}

	// Should NOT have tried podman run
	runAsCalls := fake.CallsFor("RunAs")
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman run") {
			t.Error("should not attempt podman run after build failure")
		}
	}
}

func TestSiteDeploy_Execute_WithEnvVars(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	p := validDeployParams()
	p.EnvVars = map[string]string{
		"DB_HOST":     "localhost",
		"DB_PASSWORD": "secret123",
		"API_KEY":     "abc",
	}
	params, _ := json.Marshal(p)
	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	envPath := "/srv/forja/accounts/demo/sites/example.com/.env"
	envContent := string(fake.WriteFileData[envPath])

	if !strings.Contains(envContent, "NODE_ENV=production") {
		t.Error("env file should contain NODE_ENV")
	}
	if !strings.Contains(envContent, "DB_HOST=localhost") {
		t.Error("env file should contain DB_HOST")
	}
	if !strings.Contains(envContent, "DB_PASSWORD=secret123") {
		t.Error("env file should contain DB_PASSWORD")
	}
	if !strings.Contains(envContent, "API_KEY=abc") {
		t.Error("env file should contain API_KEY")
	}

	// User vars should come after system vars (sorted)
	nodeIdx := strings.Index(envContent, "NODE_ENV")
	apiIdx := strings.Index(envContent, "API_KEY")
	if apiIdx < nodeIdx {
		t.Error("user vars should come after system vars")
	}
}

func TestSiteDeploy_Validate_InvalidOldContainer(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validDeployParams()
	p.OldContainer = "--all"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for OldContainer='--all'")
	}
}

func TestSiteDeploy_Validate_InvalidEnvKey(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validDeployParams()
	p.EnvVars = map[string]string{"1INVALID": "val"}
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid env key")
	}
}

func TestBuildEnvFile_Node(t *testing.T) {
	content := buildEnvFile("node", 10000, map[string]string{
		"Z_VAR": "last",
		"A_VAR": "first",
	})
	lines := strings.Split(strings.TrimSpace(content), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "NODE_ENV=production" {
		t.Errorf("line 0: %s", lines[0])
	}
	if lines[1] != "PORT=3000" {
		t.Errorf("line 1: %s", lines[1])
	}
	if lines[2] != "A_VAR=first" {
		t.Errorf("line 2: %s", lines[2])
	}
	if lines[3] != "Z_VAR=last" {
		t.Errorf("line 3: %s", lines[3])
	}
}

func TestBuildEnvFile_PHP(t *testing.T) {
	content := buildEnvFile("php", 10000, nil)
	if !strings.Contains(content, "PORT=8080") {
		t.Error("PHP env should contain PORT=8080")
	}
	if strings.Contains(content, "NODE_ENV") {
		t.Error("PHP env should not contain NODE_ENV")
	}
}

func TestBuildEnvFile_Python(t *testing.T) {
	content := buildEnvFile("python", 10000, nil)
	if !strings.Contains(content, "PORT=8000") {
		t.Error("Python env should contain PORT=8000")
	}
}

func TestBuildEnvFile_Static(t *testing.T) {
	content := buildEnvFile("static", 10000, nil)
	if strings.Contains(content, "PORT=") {
		t.Error("Static env should not contain PORT")
	}
}

func TestBuildEnvFile_Docker(t *testing.T) {
	content := buildEnvFile("docker", 10000, nil)
	if !strings.Contains(content, "PORT=10000") {
		t.Error("Docker env should contain PORT=<targetPort>")
	}
}

func TestGenerateNodeContainerfile_Defaults(t *testing.T) {
	p := SiteDeployParams{Runtime: "node", RuntimeVersion: "20"}
	cf := generateNodeContainerfile(p)
	if !strings.Contains(cf, "node:20-alpine") {
		t.Error("expected node:20-alpine")
	}
	if !strings.Contains(cf, "RUN npm ci") {
		t.Error("expected default npm ci")
	}
	if !strings.Contains(cf, "CMD npm start") {
		t.Error("expected default npm start")
	}
}

func TestGenerateNodeContainerfile_CustomCmds(t *testing.T) {
	p := SiteDeployParams{
		Runtime:        "node",
		RuntimeVersion: "22",
		InstallCmd:     "pnpm install --frozen-lockfile",
		BuildCmd:       "npm run build",
		StartCmd:       "node dist/index.js",
	}
	cf := generateNodeContainerfile(p)
	if !strings.Contains(cf, "RUN pnpm install --frozen-lockfile") {
		t.Error("expected custom install cmd")
	}
	if !strings.Contains(cf, "RUN npm run build") {
		t.Error("expected custom build cmd")
	}
	if !strings.Contains(cf, "CMD node dist/index.js") {
		t.Error("expected custom start cmd")
	}
}

func TestGenerateNodeContainerfile_NoBuild(t *testing.T) {
	p := SiteDeployParams{Runtime: "node", RuntimeVersion: "22", InstallCmd: "npm ci", StartCmd: "npm start"}
	cf := generateNodeContainerfile(p)
	lines := strings.Split(cf, "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "RUN ") && line != "RUN npm ci" {
			t.Errorf("unexpected RUN line without build cmd: %s", line)
		}
	}
}

func TestGeneratePHPContainerfile(t *testing.T) {
	p := SiteDeployParams{Runtime: "php", RuntimeVersion: "8.4", PublicDir: "web"}
	cf := generatePHPContainerfile(p)
	if !strings.Contains(cf, "php:8.4-cli-alpine") {
		t.Error("expected php:8.4-cli-alpine")
	}
	if !strings.Contains(cf, "EXPOSE 8080") {
		t.Error("expected EXPOSE 8080")
	}
	if !strings.Contains(cf, "-t web") {
		t.Error("expected -t web for public dir")
	}
}

func TestGeneratePHPContainerfile_DefaultPublicDir(t *testing.T) {
	p := SiteDeployParams{Runtime: "php", RuntimeVersion: "8.3"}
	cf := generatePHPContainerfile(p)
	if !strings.Contains(cf, "-t public") {
		t.Error("expected default public dir")
	}
}

func TestGeneratePHPContainerfile_WithInstallCmd(t *testing.T) {
	p := SiteDeployParams{Runtime: "php", RuntimeVersion: "8.4", InstallCmd: "composer install --no-dev"}
	cf := generatePHPContainerfile(p)
	if !strings.Contains(cf, "RUN composer install --no-dev") {
		t.Error("expected install cmd")
	}
}

func TestGeneratePythonContainerfile(t *testing.T) {
	p := SiteDeployParams{Runtime: "python", RuntimeVersion: "3.13"}
	cf := generatePythonContainerfile(p)
	if !strings.Contains(cf, "python:3.13-slim") {
		t.Error("expected python:3.13-slim")
	}
	if !strings.Contains(cf, "EXPOSE 8000") {
		t.Error("expected EXPOSE 8000")
	}
	if !strings.Contains(cf, "pip install --no-cache-dir -r requirements.txt") {
		t.Error("expected default pip install")
	}
	if !strings.Contains(cf, "CMD gunicorn app:app") {
		t.Error("expected default gunicorn cmd")
	}
}

func TestGeneratePythonContainerfile_CustomCmds(t *testing.T) {
	p := SiteDeployParams{
		Runtime:        "python",
		RuntimeVersion: "3.12",
		InstallCmd:     "pip install -e .",
		StartCmd:       "uvicorn main:app --host 0.0.0.0 --port 8000",
		BuildCmd:       "python manage.py collectstatic",
	}
	cf := generatePythonContainerfile(p)
	if !strings.Contains(cf, "RUN pip install -e .") {
		t.Error("expected custom install")
	}
	if !strings.Contains(cf, "RUN python manage.py collectstatic") {
		t.Error("expected build cmd")
	}
	if !strings.Contains(cf, "CMD uvicorn main:app") {
		t.Error("expected custom start")
	}
}

func TestGenerateStaticContainerfile_WithBuild(t *testing.T) {
	p := SiteDeployParams{
		Runtime:    "static",
		InstallCmd: "npm ci",
		BuildCmd:   "npm run build",
		PublicDir:  "dist",
	}
	cf := generateStaticContainerfile(p)
	if !strings.Contains(cf, "node:22-alpine AS build") {
		t.Error("expected multistage build")
	}
	if !strings.Contains(cf, "RUN npm ci") {
		t.Error("expected install cmd")
	}
	if !strings.Contains(cf, "RUN npm run build") {
		t.Error("expected build cmd")
	}
	if !strings.Contains(cf, "caddy:2-alpine") {
		t.Error("expected caddy image")
	}
	if !strings.Contains(cf, "COPY --from=build /app/dist /srv") {
		t.Error("expected copy from build stage")
	}
	if !strings.Contains(cf, "EXPOSE 80") {
		t.Error("expected EXPOSE 80")
	}
}

func TestGenerateStaticContainerfile_NoBuild(t *testing.T) {
	p := SiteDeployParams{Runtime: "static", PublicDir: "www"}
	cf := generateStaticContainerfile(p)
	if strings.Contains(cf, "AS build") {
		t.Error("should not have multistage without build cmd")
	}
	if !strings.Contains(cf, "caddy:2-alpine") {
		t.Error("expected caddy image")
	}
	if !strings.Contains(cf, "COPY www /srv") {
		t.Error("expected direct copy of public dir")
	}
}

func TestContainerPort(t *testing.T) {
	tests := []struct {
		runtime    string
		targetPort int
		want       int
	}{
		{"node", 10000, 3000},
		{"php", 10000, 8080},
		{"python", 10000, 8000},
		{"static", 10000, 80},
		{"docker", 10000, 10000},
		{"docker", 10001, 10001},
	}
	for _, tt := range tests {
		if got := containerPort(tt.runtime, tt.targetPort); got != tt.want {
			t.Errorf("containerPort(%q, %d) = %d, want %d", tt.runtime, tt.targetPort, got, tt.want)
		}
	}
}

func validPHPDeployParams() SiteDeployParams {
	return SiteDeployParams{
		AccountSlug:    "demo",
		Domain:         "phpsite.com",
		Runtime:        "php",
		RuntimeVersion: "8.4",
		Repo:           "https://github.com/user/phprepo",
		Branch:         "main",
		Commit:         "abc1234",
		InstallCmd:     "composer install --no-dev",
		PublicDir:      "public",
		TargetPort:     10000,
		CPUMillis:      1000,
		MemoryMB:       512,
	}
}

func validPythonDeployParams() SiteDeployParams {
	return SiteDeployParams{
		AccountSlug:    "demo",
		Domain:         "pysite.com",
		Runtime:        "python",
		RuntimeVersion: "3.13",
		Repo:           "https://github.com/user/pyrepo",
		Branch:         "main",
		Commit:         "abc1234",
		InstallCmd:     "pip install --no-cache-dir -r requirements.txt",
		StartCmd:       "gunicorn app:app -b 0.0.0.0:8000",
		TargetPort:     10000,
		CPUMillis:      1000,
		MemoryMB:       512,
	}
}

func validStaticDeployParams() SiteDeployParams {
	return SiteDeployParams{
		AccountSlug: "demo",
		Domain:      "static.com",
		Runtime:     "static",
		Repo:        "https://github.com/user/staticrepo",
		Branch:      "main",
		Commit:      "abc1234",
		InstallCmd:  "npm ci",
		BuildCmd:    "npm run build",
		PublicDir:   "dist",
		TargetPort:  10000,
		CPUMillis:   1000,
		MemoryMB:    512,
	}
}

func validDockerDeployParams() SiteDeployParams {
	return SiteDeployParams{
		AccountSlug: "demo",
		Domain:      "custom.com",
		Runtime:     "docker",
		Repo:        "https://github.com/user/dockerrepo",
		Branch:      "main",
		Commit:      "abc1234",
		TargetPort:  10000,
		CPUMillis:   1000,
		MemoryMB:    512,
	}
}

func TestSiteDeploy_Validate_PHP_OK(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	params, _ := json.Marshal(validPHPDeployParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestSiteDeploy_Validate_PHP_InvalidVersion(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validPHPDeployParams()
	p.RuntimeVersion = "7.4"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for unsupported PHP version")
	}
}

func TestSiteDeploy_Validate_Python_OK(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	params, _ := json.Marshal(validPythonDeployParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestSiteDeploy_Validate_Python_InvalidVersion(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	p := validPythonDeployParams()
	p.RuntimeVersion = "2.7"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for unsupported Python version")
	}
}

func TestSiteDeploy_Validate_Static_OK(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	params, _ := json.Marshal(validStaticDeployParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestSiteDeploy_Validate_Docker_OK(t *testing.T) {
	a := &SiteDeploy{OS: &osutil.FakeExecutor{}, Health: &health.FakeChecker{}}
	params, _ := json.Marshal(validDockerDeployParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestSiteDeploy_Execute_PHP(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	params, _ := json.Marshal(validPHPDeployParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteDeployResult)
	if r.ActivePort != 10000 {
		t.Errorf("expected port 10000, got %d", r.ActivePort)
	}

	cfPath := "/srv/forja/accounts/demo/sites/phpsite.com/Containerfile"
	cfContent := string(fake.WriteFileData[cfPath])
	if !strings.Contains(cfContent, "php:8.4-cli-alpine") {
		t.Errorf("expected php:8.4-cli-alpine in Containerfile, got:\n%s", cfContent)
	}

	runAsCalls := fake.CallsFor("RunAs")
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman run") && !strings.Contains(args, ":8080") {
			t.Error("podman run should map to container port 8080")
		}
	}

	envPath := "/srv/forja/accounts/demo/sites/phpsite.com/.env"
	envContent := string(fake.WriteFileData[envPath])
	if !strings.Contains(envContent, "PORT=8080") {
		t.Error("env file should contain PORT=8080")
	}
}

func TestSiteDeploy_Execute_Python(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	params, _ := json.Marshal(validPythonDeployParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteDeployResult)
	if r.ActivePort != 10000 {
		t.Errorf("expected port 10000, got %d", r.ActivePort)
	}

	cfPath := "/srv/forja/accounts/demo/sites/pysite.com/Containerfile"
	cfContent := string(fake.WriteFileData[cfPath])
	if !strings.Contains(cfContent, "python:3.13-slim") {
		t.Errorf("expected python:3.13-slim in Containerfile, got:\n%s", cfContent)
	}

	runAsCalls := fake.CallsFor("RunAs")
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman run") && !strings.Contains(args, ":8000") {
			t.Error("podman run should map to container port 8000")
		}
	}
}

func TestSiteDeploy_Execute_Static(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	params, _ := json.Marshal(validStaticDeployParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteDeployResult)
	if r.ActivePort != 10000 {
		t.Errorf("expected port 10000, got %d", r.ActivePort)
	}

	cfPath := "/srv/forja/accounts/demo/sites/static.com/Containerfile"
	cfContent := string(fake.WriteFileData[cfPath])
	if !strings.Contains(cfContent, "caddy:2-alpine") {
		t.Errorf("expected caddy:2-alpine in Containerfile, got:\n%s", cfContent)
	}
	if !strings.Contains(cfContent, "COPY --from=build /app/dist /srv") {
		t.Error("expected multistage copy for static with build")
	}

	runAsCalls := fake.CallsFor("RunAs")
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman run") && !strings.Contains(args, ":80") {
			t.Error("podman run should map to container port 80")
		}
	}
}

func TestSiteDeploy_Execute_Docker(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	hc := &health.FakeChecker{}
	a := &SiteDeploy{OS: fake, Health: hc}

	params, _ := json.Marshal(validDockerDeployParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteDeployResult)
	if r.ActivePort != 10000 {
		t.Errorf("expected port 10000, got %d", r.ActivePort)
	}

	// Docker runtime should NOT write a Containerfile
	cfPath := "/srv/forja/accounts/demo/sites/custom.com/Containerfile"
	if _, ok := fake.WriteFileData[cfPath]; ok {
		t.Error("docker runtime should not generate a Containerfile")
	}

	// Should use Dockerfile from repo
	runAsCalls := fake.CallsFor("RunAs")
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman build") {
			if !strings.Contains(args, "Dockerfile") {
				t.Error("docker runtime should use Dockerfile from repo")
			}
		}
	}

	// podman run should map targetPort:targetPort for docker
	for _, c := range runAsCalls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "podman run") && !strings.Contains(args, "10000:10000") {
			t.Error("docker runtime should map targetPort:targetPort")
		}
	}

	// Env should contain PORT=targetPort
	envPath := "/srv/forja/accounts/demo/sites/custom.com/.env"
	envContent := string(fake.WriteFileData[envPath])
	if !strings.Contains(envContent, "PORT=10000") {
		t.Error("docker env file should contain PORT=<targetPort>")
	}
}
