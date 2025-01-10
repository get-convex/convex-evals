import os
import subprocess
import requests

def deploy(output_dir: str):
    project_dir = os.path.abspath(os.path.join(output_dir, 'project'))

    backend_dir = os.path.join(output_dir, 'backend')
    os.makedirs(backend_dir, exist_ok=True)

    storage_dir = os.path.abspath(os.path.join(backend_dir, 'convex_local_storage'))
    os.makedirs(storage_dir, exist_ok=True)
    sqlite_path = os.path.abspath(os.path.join(backend_dir, 'convex_local_backend.sqlite3'))
    instance_name = 'carnitas'
    instance_secret = '4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974'
    admin_key = '0135d8598650f8f5cb0f30c34ec2e2bb62793bc28717c8eb6fb577996d50be5f4281b59181095065c5d0f86a2c31ddbe9b597ec62b47ded69782cd'
    convex_binary = os.path.abspath('convex-local-backend')
    convex_process = subprocess.Popen(
        [
            convex_binary,            
            '--port', '3210', 
            '--site-proxy-port', '3211', 
            '--instance-name', instance_name, 
            '--instance-secret', instance_secret, 
            '--local-storage', storage_dir, 
            sqlite_path
        ],
        cwd=backend_dir,
        stdout=open(os.path.join(backend_dir, 'backend.stdout.log'), 'w'),
        stderr=open(os.path.join(backend_dir, 'backend.stderr.log'), 'w')
    )    
    try:
        # Do a health check and then make sure that *our* process is still running.
        requests.get('http://localhost:3210/version').raise_for_status()    
        if convex_process.poll() is not None:
            raise ValueError("Convex process failed to start")        
        subprocess.check_call(
            ['bunx', 'convex', 'dev', '--once', '--admin-key', admin_key, '--url', 'http://localhost:3210'],
            cwd=project_dir,
        )                
    finally:
        convex_process.terminate()