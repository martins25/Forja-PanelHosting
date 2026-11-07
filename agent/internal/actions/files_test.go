package actions

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func setupAccountHome(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	home := filepath.Join(base, "demo")
	if err := os.MkdirAll(home, 0755); err != nil {
		t.Fatal(err)
	}
	return base
}

// --- files.list ---

func TestFilesList_Name(t *testing.T) {
	a := &FilesList{OS: &osutil.FakeExecutor{}}
	if a.Name() != "files.list" {
		t.Errorf("expected files.list, got %s", a.Name())
	}
}

func TestFilesList_Validate_OK(t *testing.T) {
	a := &FilesList{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesListParams{AccountSlug: "demo", Path: "."})
	if err := a.Validate(params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFilesList_Validate_EmptyPath(t *testing.T) {
	a := &FilesList{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesListParams{AccountSlug: "demo"})
	if err := a.Validate(params); err != nil {
		t.Fatalf("empty path should be accepted (defaults to .): %v", err)
	}
}

func TestFilesList_Validate_BadSlug(t *testing.T) {
	a := &FilesList{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesListParams{AccountSlug: "../evil", Path: "."})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for bad slug")
	}
}

func TestFilesList_Execute_OK(t *testing.T) {
	base := setupAccountHome(t)
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return []byte("index.js\tf\t1234\t1699000000.0\t0644\nnode_modules\td\t4096\t1699000000.0\t0755\n"), nil
	}

	a := &FilesList{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesListParams{AccountSlug: "demo", Path: "."})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesListResult)
	if len(r.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(r.Entries))
	}
	if r.Entries[0].Name != "index.js" || r.Entries[0].Type != "file" {
		t.Errorf("unexpected first entry: %+v", r.Entries[0])
	}
	if r.Entries[1].Name != "node_modules" || r.Entries[1].Type != "dir" {
		t.Errorf("unexpected second entry: %+v", r.Entries[1])
	}
}

func TestFilesList_Execute_EmptyDir(t *testing.T) {
	base := setupAccountHome(t)
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return []byte(""), nil
	}

	a := &FilesList{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesListParams{AccountSlug: "demo", Path: "."})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesListResult)
	if len(r.Entries) != 0 {
		t.Fatalf("expected 0 entries, got %d", len(r.Entries))
	}
}

func TestParseFileEntries_SymlinkType(t *testing.T) {
	entries := parseFileEntries("mylink\tl\t10\t1699000000.0\t0777\n")
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Type != "symlink" {
		t.Errorf("expected symlink type, got %s", entries[0].Type)
	}
}

// --- files.read ---

func TestFilesRead_Name(t *testing.T) {
	a := &FilesRead{OS: &osutil.FakeExecutor{}}
	if a.Name() != "files.read" {
		t.Errorf("expected files.read, got %s", a.Name())
	}
}

func TestFilesRead_Validate_OK(t *testing.T) {
	a := &FilesRead{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesReadParams{AccountSlug: "demo", Path: "index.js"})
	if err := a.Validate(params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFilesRead_Validate_EmptyPath(t *testing.T) {
	a := &FilesRead{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesReadParams{AccountSlug: "demo", Path: ""})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestFilesRead_Execute_TextFile(t *testing.T) {
	base := setupAccountHome(t)
	home := filepath.Join(base, "demo")
	filePath := filepath.Join(home, "index.js")
	os.WriteFile(filePath, []byte("hello world!\n"), 0644)

	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, cmd string, args ...string) ([]byte, error) {
		if cmd == "/usr/bin/stat" {
			return []byte("13\n"), nil
		}
		if cmd == "/usr/bin/cat" {
			return []byte("hello world!\n"), nil
		}
		return nil, fmt.Errorf("unexpected command: %s", cmd)
	}

	a := &FilesRead{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesReadParams{AccountSlug: "demo", Path: "index.js"})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesReadResult)
	if r.Encoding != "utf-8" {
		t.Errorf("expected utf-8 encoding, got %s", r.Encoding)
	}
	if r.Content != "hello world!\n" {
		t.Errorf("unexpected content: %q", r.Content)
	}
	if r.Name != "index.js" {
		t.Errorf("unexpected name: %s", r.Name)
	}
}

func TestFilesRead_Execute_BinaryFile(t *testing.T) {
	base := setupAccountHome(t)
	home := filepath.Join(base, "demo")
	filePath := filepath.Join(home, "image.png")
	binaryData := []byte{0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02}
	os.WriteFile(filePath, binaryData, 0644)

	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, cmd string, args ...string) ([]byte, error) {
		if cmd == "/usr/bin/stat" {
			return []byte("7\n"), nil
		}
		if cmd == "/usr/bin/cat" {
			return binaryData, nil
		}
		return nil, fmt.Errorf("unexpected command: %s", cmd)
	}

	a := &FilesRead{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesReadParams{AccountSlug: "demo", Path: "image.png"})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesReadResult)
	if r.Encoding != "base64" {
		t.Errorf("expected base64 encoding, got %s", r.Encoding)
	}
	decoded, _ := base64.StdEncoding.DecodeString(r.Content)
	if len(decoded) != len(binaryData) {
		t.Errorf("decoded length mismatch: %d vs %d", len(decoded), len(binaryData))
	}
}

func TestFilesRead_Execute_TooLarge(t *testing.T) {
	base := setupAccountHome(t)
	home := filepath.Join(base, "demo")
	filePath := filepath.Join(home, "huge.bin")
	os.WriteFile(filePath, []byte("x"), 0644)

	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return []byte("6000000\n"), nil
	}

	a := &FilesRead{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesReadParams{AccountSlug: "demo", Path: "huge.bin"})
	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for file too large")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Errorf("expected 'too large' error, got: %v", err)
	}
}

// --- files.write ---

func TestFilesWrite_Name(t *testing.T) {
	a := &FilesWrite{OS: &osutil.FakeExecutor{}}
	if a.Name() != "files.write" {
		t.Errorf("expected files.write, got %s", a.Name())
	}
}

func TestFilesWrite_Validate_OK(t *testing.T) {
	a := &FilesWrite{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesWriteParams{AccountSlug: "demo", Path: "test.txt", Content: "hello"})
	if err := a.Validate(params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFilesWrite_Validate_TooLargeContent(t *testing.T) {
	a := &FilesWrite{OS: &osutil.FakeExecutor{}}
	bigContent := strings.Repeat("x", 6*1024*1024)
	params, _ := json.Marshal(FilesWriteParams{AccountSlug: "demo", Path: "big.txt", Content: bigContent})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for content too large")
	}
}

func TestFilesWrite_Validate_EmptyPath(t *testing.T) {
	a := &FilesWrite{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesWriteParams{AccountSlug: "demo", Path: "", Content: "hello"})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestFilesWrite_Execute_OK(t *testing.T) {
	base := setupAccountHome(t)
	home := filepath.Join(base, "demo")
	os.MkdirAll(filepath.Join(home, "app"), 0755)

	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1000, 1000}
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return nil, nil
	}

	a := &FilesWrite{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesWriteParams{AccountSlug: "demo", Path: "app/index.js", Content: "console.log('hi')"})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesWriteResult)
	if r.Size != 17 {
		t.Errorf("expected size 17, got %d", r.Size)
	}

	written := fake.WriteFileData[filepath.Join(home, "app", "index.js")]
	if string(written) != "console.log('hi')" {
		t.Errorf("unexpected written content: %q", string(written))
	}
}

// --- files.delete ---

func TestFilesDelete_Name(t *testing.T) {
	a := &FilesDelete{OS: &osutil.FakeExecutor{}}
	if a.Name() != "files.delete" {
		t.Errorf("expected files.delete, got %s", a.Name())
	}
}

func TestFilesDelete_Validate_OK(t *testing.T) {
	a := &FilesDelete{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesDeleteParams{AccountSlug: "demo", Path: "old.js"})
	if err := a.Validate(params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFilesDelete_Validate_EmptyPath(t *testing.T) {
	a := &FilesDelete{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesDeleteParams{AccountSlug: "demo", Path: ""})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestFilesDelete_Execute_NonRecursive(t *testing.T) {
	base := setupAccountHome(t)
	home := filepath.Join(base, "demo")
	os.WriteFile(filepath.Join(home, "old.js"), []byte("x"), 0644)

	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return nil, nil
	}

	a := &FilesDelete{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesDeleteParams{AccountSlug: "demo", Path: "old.js", Recursive: false})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesDeleteResult)
	if r.Path != "old.js" {
		t.Errorf("unexpected path: %s", r.Path)
	}

	for _, c := range fake.Calls {
		if c.Method == "RunAs" {
			for _, a := range c.Args {
				if a == "-rf" {
					t.Error("non-recursive delete should not use -rf")
				}
			}
		}
	}
}

func TestFilesDelete_Execute_Recursive(t *testing.T) {
	base := setupAccountHome(t)
	home := filepath.Join(base, "demo")
	os.MkdirAll(filepath.Join(home, "node_modules"), 0755)

	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return nil, nil
	}

	a := &FilesDelete{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesDeleteParams{AccountSlug: "demo", Path: "node_modules", Recursive: true})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesDeleteResult)
	if r.Path != "node_modules" {
		t.Errorf("unexpected path: %s", r.Path)
	}

	foundRF := false
	for _, c := range fake.Calls {
		if c.Method == "RunAs" {
			for _, a := range c.Args {
				if a == "-rf" {
					foundRF = true
				}
			}
		}
	}
	if !foundRF {
		t.Error("recursive delete should use -rf")
	}
}

func TestFilesDelete_Execute_RejectsHomeDir(t *testing.T) {
	base := setupAccountHome(t)

	fake := osutil.NewFakeExecutor()
	a := &FilesDelete{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesDeleteParams{AccountSlug: "demo", Path: "."})
	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error when deleting home dir")
	}
	if !strings.Contains(err.Error(), "home directory") {
		t.Errorf("unexpected error: %v", err)
	}
}

// --- files.mkdir ---

func TestFilesMkdir_Name(t *testing.T) {
	a := &FilesMkdir{OS: &osutil.FakeExecutor{}}
	if a.Name() != "files.mkdir" {
		t.Errorf("expected files.mkdir, got %s", a.Name())
	}
}

func TestFilesMkdir_Validate_OK(t *testing.T) {
	a := &FilesMkdir{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesMkdirParams{AccountSlug: "demo", Path: "newdir"})
	if err := a.Validate(params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFilesMkdir_Validate_EmptyPath(t *testing.T) {
	a := &FilesMkdir{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesMkdirParams{AccountSlug: "demo", Path: ""})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestFilesMkdir_Execute_OK(t *testing.T) {
	base := setupAccountHome(t)

	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return nil, nil
	}

	a := &FilesMkdir{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesMkdirParams{AccountSlug: "demo", Path: "subdir"})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesMkdirResult)
	if r.Path != "subdir" {
		t.Errorf("unexpected path: %s", r.Path)
	}
}

// --- files.upload ---

func TestFilesUpload_Name(t *testing.T) {
	a := &FilesUpload{OS: &osutil.FakeExecutor{}}
	if a.Name() != "files.upload" {
		t.Errorf("expected files.upload, got %s", a.Name())
	}
}

func TestFilesUpload_Validate_OK(t *testing.T) {
	a := &FilesUpload{OS: &osutil.FakeExecutor{}}
	content := base64.StdEncoding.EncodeToString([]byte("hello"))
	params, _ := json.Marshal(FilesUploadParams{AccountSlug: "demo", Path: "file.txt", ContentBase64: content})
	if err := a.Validate(params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFilesUpload_Validate_EmptyContent(t *testing.T) {
	a := &FilesUpload{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesUploadParams{AccountSlug: "demo", Path: "file.txt", ContentBase64: ""})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty content")
	}
}

func TestFilesUpload_Validate_InvalidBase64(t *testing.T) {
	a := &FilesUpload{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(FilesUploadParams{AccountSlug: "demo", Path: "file.txt", ContentBase64: "not-valid-base64!!!"})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestFilesUpload_Execute_OK(t *testing.T) {
	base := setupAccountHome(t)
	home := filepath.Join(base, "demo")
	os.MkdirAll(filepath.Join(home, "upload"), 0755)

	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1000, 1000}
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
		return nil, nil
	}

	content := base64.StdEncoding.EncodeToString([]byte("binary data"))

	a := &FilesUpload{OS: fake, BasePath: base}
	params, _ := json.Marshal(FilesUploadParams{AccountSlug: "demo", Path: "upload/file.bin", ContentBase64: content})
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*FilesUploadResult)
	if r.Size != 11 {
		t.Errorf("expected size 11, got %d", r.Size)
	}

	written := fake.WriteFileData[filepath.Join(home, "upload", "file.bin")]
	if string(written) != "binary data" {
		t.Errorf("unexpected written content: %q", string(written))
	}
}

// --- isBinary ---

func TestIsBinary(t *testing.T) {
	if isBinary([]byte("hello world")) {
		t.Error("text should not be binary")
	}
	if !isBinary([]byte{0x89, 0x50, 0x00, 0x47}) {
		t.Error("data with null bytes should be binary")
	}
	if isBinary([]byte{}) {
		t.Error("empty data should not be binary")
	}
}

// --- path traversal ---

func TestFilesRead_PathTraversal(t *testing.T) {
	base := setupAccountHome(t)
	fake := osutil.NewFakeExecutor()
	a := &FilesRead{OS: fake, BasePath: base}

	params, _ := json.Marshal(FilesReadParams{AccountSlug: "demo", Path: "../../etc/passwd"})
	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
}

func TestFilesDelete_PathTraversal(t *testing.T) {
	base := setupAccountHome(t)
	fake := osutil.NewFakeExecutor()
	a := &FilesDelete{OS: fake, BasePath: base}

	params, _ := json.Marshal(FilesDeleteParams{AccountSlug: "demo", Path: "../other-account/data"})
	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
}

func TestFilesWrite_PathTraversal(t *testing.T) {
	base := setupAccountHome(t)
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1000, 1000}
	a := &FilesWrite{OS: fake, BasePath: base}

	params, _ := json.Marshal(FilesWriteParams{AccountSlug: "demo", Path: "../../etc/crontab", Content: "evil"})
	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
}
