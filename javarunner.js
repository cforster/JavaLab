var _ = require('underscore')._;
var child_process = require('child_process');
var fs = require('fs');
var jayson = require('jayson');
var path = require('path');
var util = require('util');

var USE_COMPILE_SERVER =
  process.env.npm_package_config_useCompileServer == 'true';
var COMPILE_SERVER_PORT =
  process.env.npm_package_config_compileServerPort || 30415;

var DATA_PATH = '/tmp/javarunner';
var POLICY_FILE = '/tmp/javarunnerpolicy';
var PROC_CPU_HZ = 100;  // units in /proc/*/stat, depends on kernel setting

// Java process limits, to prevent abuse
var MAX_JAVA_HEAP = '10M';
var MAX_JAVA_STACK = '5M';
var MAX_JAVA_CPU_SECONDS = 5;

fs.mkdir(DATA_PATH, function(e) {
  if (e && e.code != 'EEXIST') throw e;
  fs.writeFile(POLICY_FILE, 'grant {};', function(e) {
    if (e) throw e;
  });
});

var compileServerClient =
  jayson.client.http({port: Number(COMPILE_SERVER_PORT),
                      hostname: 'localhost'});
if (USE_COMPILE_SERVER) {
  function startCompileServer() {
    var compileServer = child_process.spawn(
      'java', ['-cp',
               'jars/jsonrpc2-base-1.30.jar:jars/jsonrpc2-server-1.8.jar:.',
               'CompileServer', COMPILE_SERVER_PORT]);

    function logNewLines(lineData) {
      var lines = lineData.split('\n');
      if (lines.length > 1) {
        _.each(_.initial(lines), function(line) {
          util.log('javarunner compileServer: ' + line);
        });
        return lines[lines.length - 1];
      }
      return lineData;
    }

    var stdout = '';
    compileServer.stdout.on('data', function(data) {
      stdout += String(data);
      stdout = logNewLines(stdout);
    });

    var stderr = '';
    compileServer.stderr.on('data', function(data) {
      stderr += String(data);
      stderr = logNewLines(stderr);
    });

    compileServer.on('exit', function(code) {
      util.log('javarunner compileServer exited with code ' + code);
      setTimeout(startCompileServer, 1000);
    });
  }
  startCompileServer();
}

function getCPUSeconds(pid, callback) {
  fs.readFile('/proc/' + pid + '/stat', function(e, data) {
    if (e && (e.code == 'ENOENT' || e.code == 'ESRCH')) {
      return callback(null);
    }
    if (e) {
      util.log('Error reading from /proc/' + pid + '/stat: ' + e);
      return callback(null);
    }
    var parts = data.toString().split(' ');
    var cpuTime = (Number(parts[13]) + Number(parts[14])) / PROC_CPU_HZ;
    callback(cpuTime);
  });
}

function parseJavacErrors(srcPath, stderr) {
  var errorStart = new RegExp('^' + srcPath + ':(\\d+): (.*)$');
  var lines = stderr.match(/[^\r\n]+/g);
  if (!lines) {
    return [];
  }
  var errors = [];
  var error = null;
  for (var i = 0; i < lines.length - 1; i++) {
    var match = lines[i].match(errorStart);
    if (match) {
      error = {line: Number(match[1]), text: match[2], detail: '', col: 0};
      errors.push(error);
    } else if (error) {
      error.detail += lines[i] + '\n';
      var caretMatch = lines[i].match(/^(\s*)\x5E\s*$/);
      if (caretMatch) {
        error.col = caretMatch[1].length;
      }
    } else {
      util.log(srcPath + ' unexpected javac output line: ' + lines[i] +
               '\nFull output:\n' + stderr);
    }
  }
  return errors;
}

function getClassName(src) {
  var match = src.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*{/m);
  if (match) {
    return match[1];
  } else {
    return null;
  }
}

var nextId = 0;
function JavaRunner(callback) {
  this.id = nextId++;
  this.state = 'idle';
  this.callback = callback;
  this.dir = path.join(DATA_PATH, String(this.id));
  this.srcPath = null;
  this.className = null;
  this.java = null;
  this.javac = null;
}

JavaRunner.prototype.setState = function(state) {
  util.log('javarunner ' + this.id + ' enters state ' + state);
  this.state = state;
  this.callback({state: state});
}

JavaRunner.prototype.compileRun = function(src) {
  var self = this;
  if (self.state == 'compile') return;
  self.setState('compile');
  if (self.java) {
    self.java.kill();
    self.java = null;
  }
  self.className = getClassName(src);
  if (!self.className) {
    self.setState('idle');
    return self.callback(
      {compileErrors: [
         {line: 1,
          col: 0,
          text: 'failed to find public class name',
          detail: 'Failed to find public class name. Code must contain ' +
          'exactly one public class with a main method.'}]});
  }
  self.srcPath = path.join(self.dir, self.className + '.java');
  self.compile(src, function(result) {
    util.log('javarunner ' + self.id +
             ' compile done (error ' + result.code + ')');
    if (result.code == 0) {
      self.setState('run');
      var java = child_process.spawn('java',
                                     ['-Djava.security.manager',
                                      '-Djava.security.policy==' + POLICY_FILE,
                                      '-Xmx' + MAX_JAVA_HEAP,
                                      '-Xss' + MAX_JAVA_STACK,
                                      '-cp', self.dir, self.className]);
      var intervalId = setInterval(function() {
        getCPUSeconds(java.pid, function(cpuSeconds) {
          if (cpuSeconds > MAX_JAVA_CPU_SECONDS) {
            util.log('javarunner ' + self.id + ' run killed (' +
                     cpuSeconds + ' cpu seconds used)');
            java.kill();
            self.callback(
              {stdout: 'Process CPU seconds ' + cpuSeconds +
               ' exceeded ' + MAX_JAVA_CPU_SECONDS + ' second limit.\n'});
          }
        });
      }, MAX_JAVA_CPU_SECONDS * 100);
      java.stdout.on('data', function(stdout) {
        self.callback({stdout: String(stdout)});
      });
      java.stderr.on('data', function(stderr) {
        self.callback({stdout: String(stderr)});
      });
      java.on('exit', function(code) {
        util.log('javarunner ' + self.id + ' run done (error ' + code + ')');
        clearInterval(intervalId);
        if (self.java == java) {
          self.setState('idle');
          self.java = null;
        }
      });
      self.java = java;
    } else {
      var errors = parseJavacErrors(self.srcPath, result.stderr);
      self.setState('idle');
      return self.callback({compileErrors: errors});
    }
  });
}

JavaRunner.prototype.stdin = function(stdin) {
  if (this.java) this.java.stdin.write(stdin);
}

JavaRunner.prototype.stop = function() {
  if (this.java) this.java.kill();
  if (this.javac) {
    this.javac.kill();
    this.javac = null;
  }
  this.setState('idle');
}

// TODO: correct javascript way to make private functions private?
JavaRunner.prototype.compile = function(src, callback) {
  var self = this;
  makeDir();

  function makeDir() {
    util.log('javarunner ' + self.id + ' mkdir ' + self.dir);
    fs.mkdir(self.dir, 0777, function(e) {
      if (e && e.code != 'EEXIST') throw e;
      writeSrcFile();
    });
  }

  function writeSrcFile() {
    util.log('javarunner ' + self.id + ' write src file ' + self.srcPath);
    fs.writeFile(self.srcPath, src, function(e) {
      if (e) throw e;
      if (USE_COMPILE_SERVER) {
        callCompileServer();
      } else {
        runJavac();
      }
    });
  }

  function runJavac() {
    var compileStart = new Date().getTime();
    util.log('javarunner ' + self.id + ' javac run');
    self.javac = child_process.spawn('javac', [self.srcPath]);
    var stdout = '';
    var stderr = '';
    self.javac.stdin.end();
    self.javac.stdout.on('data', function(data) {
      stdout += data;
    });
    self.javac.stderr.on('data', function(data) {
      stderr += data;
    });
    self.javac.on('exit', function(code) {
      util.log('javarunner ' + self.id + ' javac done in ' +
               (new Date().getTime() - compileStart) + ' ms');
      self.javac = null;
      callback({code: code,
                stdout: stdout,
                stderr: stderr});
    });
  }

  function callCompileServer() {
    var compileStart = new Date().getTime();
    util.log('javarunner ' + self.id + ' call compileServer');
    compileServerClient.request(
      'compile',
      {filename: self.srcPath},
      function(e, error, response) {
        util.log('javarunner ' + self.id + ' compileServer done in ' +
                 (new Date().getTime() - compileStart) + ' ms');
        if (e) return callback({code: 1, stdout: '', stderr: e});
        return callback({code: response.compile ? 0 : 1,
                         stdout: '',
                         stderr: response.errors});
      });
  }
}

JavaRunner.prototype.cleanup = function() {
  var self = this;
  fs.readdir(self.dir, function(e, files) {
    if (e && e.code != 'ENOENT') throw e;
    if (!files) {
      fs.rmdir(self.dir);
      return;
    }
    var filesDeleted = 0;
    for (var i = 0; i < files.length; i++) {
      fs.unlink(path.join(self.dir, files[i]), function(e) {
        if (e) throw e;
        filesDeleted++;
        if (filesDeleted == files.length) {
          fs.rmdir(self.dir);
        }
      });
    }
  });
}

exports.JavaRunner = JavaRunner;