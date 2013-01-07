{
  "targets": [
    {
      "target_name": "CompileServer",
      "type": "none",
      "actions": [
        {
          "action_name": "javac",
          "inputs": [
            "CompileServer.java",
          ],
          "outputs": [
            "CompileServer.class",
            "CompileServer$CompileHandler.class",
            "CompileServer$MyHandler.class",
          ],
          "action": [
            "javac",
            "-cp", "jars/jsonrpc2-base-1.30.jar:jars/jsonrpc2-server-1.8.jar",
            "CompileServer.java",
          ],
        },
      ],
    },
  ],
}