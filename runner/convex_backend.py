import os
import platform
import subprocess
import requests
import time
from portpicker import pick_unused_port
import threading
import functools
import contextlib
import zipfile
from runner.logging import log_info

port_lock = threading.Lock()

instance_name = "carnitas"
instance_secret = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974"

admin_key = "0135d8598650f8f5cb0f30c34ec2e2bb62793bc28717c8eb6fb577996d50be5f4281b59181095065c5d0f86a2c31ddbe9b597ec62b47ded69782cd"


@contextlib.contextmanager
def convex_backend(backend_dir: str):
    storage_dir = os.path.abspath(os.path.join(backend_dir, "convex_local_storage"))
    os.makedirs(storage_dir, exist_ok=True)
    sqlite_path = os.path.abspath(os.path.join(backend_dir, "convex_local_backend.sqlite3"))
    convex_binary = download_convex_binary()

    with port_lock:
        port = pick_unused_port()
        site_proxy_port = pick_unused_port()
        convex_process = subprocess.Popen(
            [
                convex_binary,
                "--port",
                str(port),
                "--site-proxy-port",
                str(site_proxy_port),
                "--instance-name",
                instance_name,
                "--instance-secret",
                instance_secret,
                "--local-storage",
                storage_dir,
                sqlite_path,
            ],
            cwd=backend_dir,
            stdout=open(os.path.join(backend_dir, "backend.stdout.log"), "w"),
            stderr=open(os.path.join(backend_dir, "backend.stderr.log"), "w"),
        )
    try:
        # Do a health check and then make sure that *our* process is still running.
        health_check(port)
        if convex_process.poll() is not None:
            raise ValueError("Convex process failed to start")
        yield {
            "port": port,
            "site_proxy_port": site_proxy_port,
            "process": convex_process,
        }
    finally:
        convex_process.terminate()


def health_check(port: int):
    deadline = time.time() + 10
    num_attempts = 0
    while True:
        try:
            requests.get(f"http://localhost:{port}/version").raise_for_status()
            return True
        except Exception as e:
            remaining = deadline - time.time()
            if remaining < 0:
                raise e
            time.sleep(min(0.1 * (2**num_attempts), remaining))
            num_attempts += 1


download_binary_lock = threading.Lock()


@functools.cache
def fetch_convex_releases():
    # Fetch a page of releases; if needed this can be extended to paginate
    response = requests.get(
        "https://api.github.com/repos/get-convex/convex-backend/releases",
        params={"per_page": 50},
    )
    response.raise_for_status()
    return response.json()


def download_convex_binary():
    releases = fetch_convex_releases()

    arch = {"x86_64": "x86_64", "arm64": "aarch64", "AMD64": "x86_64"}.get(
        platform.machine(), platform.machine()
    )
    triple_os = {
        "Darwin": "apple-darwin",
        "Linux": "unknown-linux-gnu",
        "Windows": "pc-windows-msvc",
    }[platform.system()]
    target_pattern = f"convex-local-backend-{arch}-{triple_os}"

    # Find the first release that contains a matching asset
    matching_asset = None
    version = None
    for release in releases:
        for asset in release.get("assets", []):
            if target_pattern in asset.get("name", ""):
                matching_asset = asset
                version = release.get("tag_name")
                break
        if matching_asset:
            break

    if not matching_asset or not version:
        raise RuntimeError(f"Could not find matching asset for {target_pattern}")

    binary_dir = os.path.expanduser("~/.convex-evals/releases")
    os.makedirs(binary_dir, exist_ok=True)

    # Include version in binary name
    binary_name = f"convex-local-backend-{version}"
    if platform.system() == "Windows":
        binary_name += ".exe"
    binary_path = os.path.join(binary_dir, binary_name)

    if os.path.exists(binary_path):
        return binary_path

    with download_binary_lock:
        if os.path.exists(binary_path):
            return binary_path

        print(f"Latest release: {version}", flush=True)

        url = matching_asset["browser_download_url"]
        print(f"Downloading: {url}", flush=True)
        response = requests.get(url, stream=True)
        response.raise_for_status()

        zip_path = os.path.join(binary_dir, matching_asset["name"])
        with open(zip_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"Downloaded: {matching_asset['name']}", flush=True)

        # Unzip the file
        with zipfile.ZipFile(zip_path, "r") as zip_ref:
            zip_ref.extractall(binary_dir)

        # Rename the extracted binary to include version
        extracted_binary = os.path.join(binary_dir, "convex-local-backend")
        if platform.system() == "Windows":
            extracted_binary += ".exe"
        os.rename(extracted_binary, binary_path)

        # Make the binary executable on Unix systems
        if platform.system() != "Windows":
            os.chmod(binary_path, 0o755)

        # Clean up zip file
        os.remove(zip_path)
        print(f"Extracted binary to: {binary_path}", flush=True)

    return binary_path
