"""scanner/core.py — Repository analysis module (from ZIP2).

FIX #7: Added explicit _validate_repo_url() helper for defense-in-depth
URL validation before git clone. Prevents SSRF via file://, ssh://, etc.
The existing _ALLOWED_URL_SCHEMES check in _clone_repo is preserved.
"""
from __future__ import annotations
import asyncio, hashlib, ipaddress, json as _json_mod, logging, os, re, shutil, socket, tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

_METADATA_IPS = {
    # IPv4 metadata endpoints
    "169.254.169.254",   # AWS / GCP / Azure / OpenStack instance metadata
    "100.100.100.200",   # Alibaba Cloud instance metadata
    "192.0.0.192",       # Reserved / cloud-init bootstrap range
    "192.168.0.1",       # Common private gateway; blocked by is_private, listed explicitly
    # IPv6 metadata endpoints
    "fd00:ec2::254",     # AWS IPv6 instance metadata (IMDSv2)
    "fe80::1",           # Common link-local gateway; blocked by is_link_local, listed explicitly
}

# TOCTOU NOTE (HIGH-02): _validate_repo_url() resolves DNS at validation time.
# The subsequent git clone in _clone_repo() re-resolves DNS independently inside
# the subprocess. A DNS rebinding attack can serve a public IP during validation
# and a private/metadata IP when git resolves, bypassing the IP check.
#
# Partial mitigations applied:
#   1. _METADATA_IPS expanded to cover IPv6 metadata addresses.
#   2. git is invoked with protocol.allow=never + GIT_ALLOW_PROTOCOL=https.
#   3. _DEFAULT_TRUSTED_HOSTS restricts the hostname universe.
#
# Full mitigation requires routing all clone traffic through a controlled egress
# proxy (e.g., Squid/Tinyproxy with an allowlist), so the proxy's resolver is
# the authoritative check — not the subprocess. Track as infra roadmap item.

_SCAN_MAX_REPOS=20; _SCAN_MAX_DURATION_S=300; _CLONE_TIMEOUT_S=60
_CLONE_MAX_SIZE_MB=500; _TREE_WALK_MAX_FILES=50_000; _TMP_MIN_FREE_MB=512
_ALLOWED_URL_SCHEMES=("https://",)
_DEFAULT_TRUSTED_HOSTS={"github.com","gitlab.com","bitbucket.org"}

_EXT_LANG:Dict[str,str]={
    ".py":"python",".pyw":"python",".pyi":"python",
    ".ts":"typescript",".tsx":"typescript",
    ".js":"javascript",".jsx":"javascript",".mjs":"javascript",
    ".go":"go",".rs":"rust",".java":"java",".kt":"kotlin",
    ".rb":"ruby",".php":"php",".cs":"csharp",".cpp":"cpp",".c":"c",
    ".swift":"swift",".scala":"scala",".ex":"elixir",".exs":"elixir",
    ".hs":"haskell",".lua":"lua",".r":"r",".sh":"shell",".dart":"dart",
}
_EXT_WEIGHTS:Dict[str,float]={
    "python":1.0,"typescript":1.2,"javascript":0.8,"go":1.0,"rust":1.0,
    "java":1.0,"kotlin":1.0,"ruby":1.0,"csharp":1.0,"cpp":0.9,"c":0.7,
    "swift":1.0,"scala":1.0,"elixir":1.0,"shell":0.3,"dart":1.0,
}
_SKIP_DIRS={".git","node_modules","__pycache__",".tox",".mypy_cache",
            ".pytest_cache","venv",".venv","env","dist","build","target",
            "vendor",".next",".nuxt"}


def _parse_host_policy_env(name:str)->set[str]:
    raw=os.environ.get(name,"")
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _trusted_hosts()->set[str]:
    configured=_parse_host_policy_env("HYPERFLOW_SCANNER_ALLOWED_HOSTS")
    if configured:
        return configured
    return set(_DEFAULT_TRUSTED_HOSTS)


def _is_denied_ip(ip:ipaddress._BaseAddress)->bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or str(ip) in _METADATA_IPS
    )


def _resolve_host_ips(hostname:str, port:int)->List[ipaddress._BaseAddress]:
    resolved=[]
    seen=set()
    for family, _, _, _, sockaddr in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM):
        raw_ip=sockaddr[0]
        if raw_ip in seen:
            continue
        seen.add(raw_ip)
        resolved.append(ipaddress.ip_address(raw_ip))
    return resolved


def _validate_repo_url(url: str) -> None:
    """Validate clone targets using scheme, host policy, and post-DNS IP policy."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(
            f"Repository URL scheme {parsed.scheme!r} is not allowed. "
            f"Only https:// is permitted in hardened scanner mode."
        )
    if parsed.username or parsed.password:
        raise ValueError("Repository URL must not contain embedded credentials")
    if not parsed.hostname:
        raise ValueError(f"Repository URL has no valid host: {url[:120]!r}")

    hostname=parsed.hostname.lower()
    allowed_hosts=_trusted_hosts()
    denied_hosts=_parse_host_policy_env("HYPERFLOW_SCANNER_DENIED_HOSTS")
    allow_private_hosts=_parse_host_policy_env("HYPERFLOW_SCANNER_ALLOW_PRIVATE_HOSTS")

    if hostname in denied_hosts:
        raise ValueError(f"Repository host {hostname!r} is explicitly denied by policy")
    if allowed_hosts and hostname not in allowed_hosts:
        raise ValueError(f"Repository host {hostname!r} is not present in the trusted-host policy")

    port=parsed.port or (443 if parsed.scheme=="https" else 80)
    try:
        resolved_ips=_resolve_host_ips(hostname, port)
    except socket.gaierror as exc:
        raise ValueError(f"Repository host {hostname!r} could not be resolved") from exc

    if not resolved_ips:
        raise ValueError(f"Repository host {hostname!r} resolved to no usable IP addresses")

    for ip in resolved_ips:
        if _is_denied_ip(ip) and hostname not in allow_private_hosts and str(ip) not in allow_private_hosts:
            raise ValueError(
                f"Repository host {hostname!r} resolves to denied address {ip}. "
                "Private, loopback, link-local, metadata, multicast, reserved, and unspecified addresses are blocked."
            )



def _tmp_free_mb(path: Path) -> int:
    """Return currently available space for the scanner work directory in MiB."""
    return shutil.disk_usage(str(path)).free // (1024 * 1024)


def _ensure_tmp_space(path: Path, min_free_mb: int = _TMP_MIN_FREE_MB) -> None:
    """Fail before clone if the temporary volume is below the configured floor."""
    free_mb = _tmp_free_mb(path)
    if free_mb < min_free_mb:
        raise RuntimeError(
            f"Insufficient temporary disk space for repository scan: "
            f"{free_mb} MiB free, requires at least {min_free_mb} MiB."
        )


def compute_overlap_scores(repos:List[Dict[str,str]])->Dict[str,float]:
    if len(repos)<=1: return {r["id"]:0.0 for r in repos}
    names=[r["name"].lower() for r in repos]
    scores:Dict[str,float]={}
    for i,repo in enumerate(repos):
        ti=set(names[i].replace("-"," ").split())
        total=0.0
        for j,other in enumerate(names):
            if i==j: continue
            tj=set(other.replace("-"," ").split())
            if ti and tj: total+=len(ti&tj)/max(len(ti),len(tj))
        scores[repo["id"]]=round(total/(len(repos)-1),4)
    return scores

def detect_language(repo_dir:Path)->str:
    counts:Dict[str,float]={}
    seen=0
    for root,dirs,files in os.walk(repo_dir):
        dirs[:]=[d for d in dirs if d not in _SKIP_DIRS]
        for fname in files:
            seen+=1
            if seen>_TREE_WALK_MAX_FILES: break
            ext=os.path.splitext(fname)[1].lower()
            lang=_EXT_LANG.get(ext)
            if lang: counts[lang]=counts.get(lang,0.0)+_EXT_WEIGHTS.get(lang,1.0)
        if seen>_TREE_WALK_MAX_FILES: break
    return max(counts,key=counts.get) if counts else "unknown"

_SERVER_PATTERNS=[
    ("main.py",r"(uvicorn|gunicorn|flask|fastapi|django|\.run\()"),
    ("app.py",r"(flask|fastapi|\.run\()"),
    ("server.ts",r"(\.listen\s*\(|express\(\)|fastify\(\))"),
    ("index.ts",r"(\.listen\s*\(|express\(\)|fastify\(\))"),
    ("main.go",r"(ListenAndServe|gin\.|echo\.|fiber\.)"),
    ("main.rs",r"(actix|rocket|axum|warp|hyper)"),
]
_INFRA_DIRS={"terraform","helm","k8s","kubernetes","ansible","pulumi"}
_INFRA_MARKERS={"Dockerfile","docker-compose.yml","docker-compose.yaml"}

def detect_classification(repo_dir:Path)->Tuple[str,Dict[str,Any]]:
    """
    Classify a repository tree and return a structured rationale.

    Precedence is intentionally centralized here for the scanner runtime and
    tests: infrastructure > service > tool > library > unknown.
    """
    infra_dirs=[d for d in _INFRA_DIRS if (repo_dir/d).is_dir()]
    infra_markers=[m for m in _INFRA_MARKERS if (repo_dir/m).exists()]
    found_infra=infra_dirs+infra_markers
    infra_detected=bool(found_infra)

    server_file=""
    server_pattern=""
    server_detected=False
    server_patterns=[
        ("server.js",  r"(listen|app\.listen|express\()"),
        ("server.ts",  r"(listen|app\.listen|express\(|fastify\()"),
        ("app.js",     r"(listen|app\.listen|express\()"),
        ("app.ts",     r"(listen|app\.listen|express\()"),
        ("index.ts",   r"(listen|app\.listen|express\(|fastify\()"),
        ("server.py",  r"(uvicorn|gunicorn|flask|fastapi|django|run\()"),
        ("app.py",     r"(uvicorn|gunicorn|flask|fastapi|django|run\()"),
        ("main.py",    r"(uvicorn|gunicorn|flask|fastapi|django|\.run\()"),
        ("main.go",    r"(ListenAndServe|gin\.|echo\.|fiber\.)"),
        ("main.rs",    r"(actix|rocket|axum|warp|hyper)"),
        ("wsgi.py",    r"."),
    ]
    for fname,pat in server_patterns:
        p=repo_dir/fname
        if not p.exists():
            continue
        try:
            if re.search(pat,p.read_text(errors="replace")[:8192]):
                server_file=fname
                server_pattern=pat
                server_detected=True
                break
        except OSError:
            continue

    cli_file=""
    cli_detected=False
    for fname in ["cli.py","__main__.py"]:
        if (repo_dir/fname).exists():
            cli_file=fname
            cli_detected=True
            break
    if not cli_detected:
        for dirname in ["bin","cli","cmd"]:
            if (repo_dir/dirname).is_dir():
                cli_file=dirname
                cli_detected=True
                break
    if not cli_detected and (repo_dir/"Cargo.toml").exists():
        try:
            if re.search(r"^\[\[bin\]\]", (repo_dir/"Cargo.toml").read_text(errors="replace"), re.MULTILINE):
                cli_file="Cargo.toml"
                cli_detected=True
        except OSError:
            pass

    lib_file=""
    lib_reason=""
    lib_detected=False
    if (repo_dir/"setup.py").exists():
        lib_file="setup.py"
        lib_reason="setup.py found — Python package manifest"
        lib_detected=True
    elif (repo_dir/"setup.cfg").exists():
        lib_file="setup.cfg"
        lib_reason="setup.cfg found — Python package manifest"
        lib_detected=True

    if not lib_detected and (repo_dir/"pyproject.toml").exists():
        try:
            text=(repo_dir/"pyproject.toml").read_text(errors="replace")
            if "[project]" in text:
                lib_file="pyproject.toml"
                lib_reason="[project] section found — PEP 621 Python package"
                lib_detected=True
        except OSError:
            pass

    if not lib_detected and (repo_dir/"package.json").exists():
        try:
            pkg=_json_mod.loads((repo_dir/"package.json").read_text(errors="replace"))
            if "main" in pkg:
                lib_file="package.json"
                lib_reason='"main" field found — CommonJS library entry'
                lib_detected=True
            elif "exports" in pkg:
                lib_file="package.json"
                lib_reason='"exports" field found — package export map'
                lib_detected=True
            elif not pkg.get("private", False):
                lib_file="package.json"
                lib_reason="public package.json (no private:true) — publishable library"
                lib_detected=True
        except Exception:
            pass

    if not lib_detected and (repo_dir/"Cargo.toml").exists():
        try:
            text=(repo_dir/"Cargo.toml").read_text(errors="replace")
            if "[lib]" in text and "[[bin]]" not in text:
                lib_file="Cargo.toml"
                lib_reason="[lib] section without [[bin]] — Rust library crate"
                lib_detected=True
        except OSError:
            pass

    if infra_detected:
        label="infrastructure"
        decision=f"Infrastructure markers detected: {', '.join(found_infra)}. Classified as infrastructure."
    elif server_detected:
        label="service"
        decision=f"Server entry point '{server_file}' matched pattern '{server_pattern}'. Classified as service."
    elif cli_detected:
        label="tool"
        decision=f"CLI entry point '{cli_file}' detected. Classified as tool."
    elif lib_detected:
        label="library"
        decision=f"Library manifest '{lib_file}': {lib_reason}. Classified as library."
    else:
        label="unknown"
        decision="No server entry, no library manifest, no CLI entry, no infrastructure markers found. Classification unknown."

    rationale={
        "serverEntry": {"detected": server_detected, "file": server_file, "pattern": server_pattern},
        "libManifest": {"detected": lib_detected, "file": lib_file, "reason": lib_reason},
        "cliEntry": {"detected": cli_detected, "file": cli_file},
        "infraMarkers": {"detected": infra_detected, "markers": found_infra},
        "decision": decision,
    }
    return label,rationale

def extract_dependencies(repo_dir:Path)->Tuple[int,List[str]]:
    def norm(n,eco):
        n=re.split(r"[><=!~;@\[]",n.strip())[0].strip()
        return n.replace("-","_").lower() if eco in ("python","rust") else n.lower()
    names:List[str]=[]
    req=repo_dir/"requirements.txt"
    if req.exists():
        for line in req.read_text(errors="replace").splitlines():
            s=line.strip()
            if s and not s.startswith(("#","-")): n=norm(s,"python"); n and names.append(n)
    py=repo_dir/"pyproject.toml"
    if py.exists():
        try:
            import tomllib
            data=tomllib.loads(py.read_text(errors="replace"))
            for dep in data.get("project",{}).get("dependencies",[]):
                n=norm(dep,"python"); n and names.append(n)
        except Exception: pass
    pkg=repo_dir/"package.json"
    if pkg.exists():
        try:
            for k in _json_mod.loads(pkg.read_text(errors="replace")).get("dependencies",{}).keys():
                names.append(k.strip().lower())
        except Exception: pass
    unique=list(dict.fromkeys(names))
    return len(unique),unique

async def _clone_repo(url:str,dest:Path,timeout:int=_CLONE_TIMEOUT_S)->float:
    if not any(url.startswith(s) for s in _ALLOWED_URL_SCHEMES):
        raise ValueError(f"URL scheme not allowed: {url[:80]}")
    proc=await asyncio.create_subprocess_exec(
        "git","-c","protocol.allow=never","-c","protocol.https.allow=always",
        "clone","--depth","1","--single-branch","--quiet",url,str(dest),
        stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.PIPE,
        env={**os.environ,"GIT_ALLOW_PROTOCOL":"https","GIT_PROTOCOL_FROM_USER":"0"})
    try: _,stderr=await asyncio.wait_for(proc.communicate(),timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill(); await proc.wait(); shutil.rmtree(dest,ignore_errors=True)
        raise TimeoutError(f"Clone timed out after {timeout}s")
    if proc.returncode!=0:
        err=(stderr or b"").decode(errors="replace").strip()
        shutil.rmtree(dest,ignore_errors=True); raise RuntimeError(f"git clone failed: {err}")
    mb=sum(f.stat().st_size for f in dest.rglob("*") if f.is_file())/(1024*1024)
    if mb>_CLONE_MAX_SIZE_MB: shutil.rmtree(dest,ignore_errors=True); raise RuntimeError(f"Clone {mb:.0f}MB > limit")
    return mb

async def analyze_repo_real(repo:Dict[str,str],work_dir:Path,overlap:float,remaining_s:float)->Dict[str,Any]:
    # FIX #7: Validate URL before attempting clone
    # Perform initial URL validation and capture the resolved IPs.  We'll re-resolve
    # the host immediately before cloning to detect DNS rebinding attacks.
    _validate_repo_url(repo["url"])
    parsed_url = urlparse(repo["url"])
    hostname = parsed_url.hostname.lower() if parsed_url.hostname else ""
    port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    try:
        resolved_ips_before = _resolve_host_ips(hostname, port)
    except Exception:
        resolved_ips_before = []
    _ensure_tmp_space(work_dir)
    safe_id=re.sub(r"[^a-zA-Z0-9_\-]","_",repo["id"])[:64]
    dest=work_dir/safe_id
    timeout=min(_CLONE_TIMEOUT_S,max(int(remaining_s),5))
    t0=datetime.now(timezone.utc)
    # Re-resolve the host immediately before calling git clone.  If the set of
    # IPs differs from the initial resolution then abort the clone since this
    # indicates a potential DNS rebinding attack.
    try:
        resolved_ips_after = _resolve_host_ips(hostname, port)
    except Exception:
        resolved_ips_after = []
    if {str(ip) for ip in resolved_ips_after} != {str(ip) for ip in resolved_ips_before}:
        raise ValueError(
            "Repository host IPs changed between validation and clone; possible DNS rebinding attack"
        )
    await _clone_repo(repo["url"],dest,timeout=timeout)
    clone_ms=int((datetime.now(timezone.utc)-t0).total_seconds()*1000)
    try:
        t1=datetime.now(timezone.utc)
        language=detect_language(dest)
        cls,rationale=detect_classification(dest)
        dep_count,dep_names=extract_dependencies(dest)
        analysis_ms=int((datetime.now(timezone.utc)-t1).total_seconds()*1000)
    finally: shutil.rmtree(dest,ignore_errors=True)
    return {"id":repo["id"],"language":language,"classification":cls,
            "classificationRationale":rationale,"dependencyCount":dep_count,
            "dependencyNames":dep_names,"overlapScore":overlap,
            "cloneDurationMs":clone_ms,"analysisDurationMs":analysis_ms,"error":None}

def analyze_repo_stub(repo:Dict[str,str],overlap:float)->Dict[str,Any]:
    n=repo["name"].lower()
    lang="typescript" if any(x in n for x in ["ts","react","ui","web","frontend"]) else "python"
    cls=("service" if any(x in n for x in ["api","server","core","worker"]) else
         "library" if any(x in n for x in ["sdk","lib","client","common"]) else
         "tool" if any(x in n for x in ["cli","tool","script"]) else "unknown")
    dep_count=int(hashlib.sha256(n.encode()).hexdigest()[:4],16)%20+1
    return {"id":repo["id"],"language":lang,"classification":cls,
            "classificationRationale":{"decision":f"stub:{cls}"},"dependencyCount":dep_count,
            "dependencyNames":[],"overlapScore":overlap,"cloneDurationMs":None,
            "analysisDurationMs":None,"error":None}
