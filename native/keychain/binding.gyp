{
  "targets": [
    {
      "target_name": "keychain",
      "sources": ["keychain.cc"],
      "defines": ["NAPI_VERSION=10"],
      "conditions": [
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "MACOSX_DEPLOYMENT_TARGET": "12.0"
            },
            "link_settings": {
              "libraries": [
                "-framework Security",
                "-framework CoreFoundation"
              ]
            }
          }
        ]
      ]
    }
  ]
}
