{
  'targets': [{
    'target_name': 'cdrip',
    'sources': ['cdrip.cc', 'mmc.cc'],
    'include_dirs': ['<!@(node -p "require(\'node:path\').relative(process.cwd(), require(\'node-addon-api\').include_dir)")'],
    'defines': ['NAPI_VERSION=8', 'NAPI_CPP_EXCEPTIONS'],
    'cflags_cc': ['-std=c++17', '-Wall', '-Wextra'],
    'cflags_cc!': ['-fno-exceptions'],
    'conditions': [
      ['OS=="linux"', {'sources': ['backend_linux.cc']}],
      ['OS=="win"', {
        'sources': ['backend_win.cc'],
        'msvs_settings': {'VCCLCompilerTool': {'ExceptionHandling': 1, 'AdditionalOptions': ['/std:c++17']}}
      }]
    ]
  }]
}
