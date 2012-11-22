var child_process = require('child_process');
var fs = require('fs');
var path = require('path');
var util = require('util');

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

function getCPUSeconds(pid, callback) {
  fs.readFile('/proc/' + pid + '/stat', function(e, data) {
    if (e && (e.code == 'ENOENT' || e.code == 'ESRCH')) callback(null);
    if (e) throw e;
    var parts = data.toString().split(' ');
    var cpuTime = (Number(parts[13]) + Number(parts[14])) / PROC_CPU_HZ;
    callback(cpuTime);
  });
}

function parseJavacErrors(srcPath, stderr) {
  var errorStart = new RegExp('^' + srcPath + ':(\\d+): (.*)$');
  var lines = stderr.match(/[^\r\n]+/g);
  var errors = [];
  var error = null;
  for (var i = 0; i < lines.length - 1; i++) {
    var match = lines[i].match(errorStart);
    if (match) {
      error = {line: Number(match[1]), text: match[2], detail: '', col: 0};
      errors.push(error);
    } else {
      error.detail += lines[i] + '\n';
      var caretMatch = lines[i].match(/^(\s*)\x5E\s*$/);
      if (caretMatch) {
	error.col = caretMatch[1].length;
      }
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
  this.intervalId = null;
}

JavaRunner.prototype.setState = function(state) {
  util.log(this.id + ' enters state ' + state);
  this.state = state;
  this.callback({state: state});
}

JavaRunner.prototype.killJavaProcess = function() {
  if (this.java) {
    this.java.kill();
    this.java = null;
  }
  if (this.intervalId) {
    clearInterval(this.intervalId);
    this.intervalId = null;
  }
}

JavaRunner.prototype.compileRun = function(src) {
  var self = this;
  if (self.state == 'compile') return;
  self.setState('compile');
  self.killJavaProcess();
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
    util.log(self.id + ' compile done (error ' + result.code + ')');
    if (result.code == 0) {
      self.setState('run');
      self.java = child_process.spawn('java',
				      ['-Djava.security.manager',
				       '-Djava.security.policy==' + POLICY_FILE,
				       '-Xmx' + MAX_JAVA_HEAP,
				       '-Xss' + MAX_JAVA_STACK,
				       '-cp', self.dir, self.className]);
      self.java.stdout.on('data', function(stdout) {
        self.callback({stdout: String(stdout)});
      });
      self.java.stderr.on('data', function(stderr) {
        self.callback({stdout: String(stderr)});
      });
      self.java.on('exit', function(code) {
	util.log(self.id + ' run done (error ' + code + ')');
	self.java = null;
	if (self.intervalId) {
	  clearInterval(self.intervalId);
	  self.intervalId = null;
	}
        if (self.state != 'compile') {
          self.setState('idle');
        }
      });
      self.intervalId = setInterval(function() {
	if (self.java) {
	  getCPUSeconds(self.java.pid, function(cpuSeconds) {
	    if (cpuSeconds > MAX_JAVA_CPU_SECONDS) {
	      util.log(self.id + ' run killed (' +
		       cpuSeconds + ' cpu seconds used)');
	      self.killJavaProcess();
              self.callback(
                {stdout: 'Process CPU seconds ' + cpuSeconds +
		 ' exceeded ' + MAX_JAVA_CPU_SECONDS + ' second limit.\n'});
	    }
	  });
	}
      }, MAX_JAVA_CPU_SECONDS * 100);
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
  this.killJavaProcess();
  this.setState('idle');
}

// TODO: correct javascript way to make private functions private?
JavaRunner.prototype.compile = function(src, callback) {
  var self = this;
  makeDir();

  function makeDir() {
    fs.mkdir(self.dir, 0777, function(e) {
      if (e && e.code != 'EEXIST') throw e;
      writeSrcFile();
    });
  }

  function writeSrcFile() {
    fs.writeFile(self.srcPath, src, function(e) {
      if (e) throw e;
      runJavac();
    });
  }

  function runJavac() {
    var javac = child_process.spawn('javac', [self.srcPath]);
    var stdout = '';
    var stderr = '';
    javac.stdin.end();
    javac.stdout.on('data', function(data) {
      stdout += data;
    });
    javac.stderr.on('data', function(data) {
      stderr += data;
    });
    javac.on('exit', function(code) {
      callback({'code': code,
		'stdout': stdout,
		'stderr': stderr});
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