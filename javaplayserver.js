var child_process = require('child_process');
var fs = require('fs');
var path = require('path');
var util = require('util');
var ws = require('ws');

var DATA_PATH = '/tmp/javaplayserver';
var POLICY_FILE = '/tmp/javaplayserverpolicy';
var PROC_CPU_HZ = 100;  // units in /proc/*/stat, depends on kernel setting

// Java process limits, to prevent abuse
var MAX_JAVA_HEAP = '10M';
var MAX_JAVA_STACK = '5M';
var MAX_JAVA_CPU_SECONDS = 5;

function getCPUSeconds(pid, callback) {
  fs.readFile('/proc/' + pid + '/stat', function(e, data) {
    if (e && e.code == 'ENOENT') callback(null);
    if (e) throw e;
    var parts = data.toString().split(' ');
    var cpuTime = (Number(parts[13]) + Number(parts[14])) / PROC_CPU_HZ;
    callback(cpuTime);
  });
}

exports.attach = function(options) {
}

exports.init = function(done) {
  var app = this;
  fs.mkdir(DATA_PATH, function(e) {
    if (e.code != 'EEXIST') throw e;
    fs.writeFile(POLICY_FILE, 'grant {};', function(e) {
      if (e) throw e;
      initServer(app.server);
      util.log('java play server started');
      done();
    });
  });
}

function initServer(server) {
  var wsServer = new ws.Server({server: server, path: '/javaplay'});
  var nextId = 0;
  wsServer.on('connection', function(sock) {
    var id = nextId++;
    var dir = path.join(DATA_PATH, String(id));
    var srcPath = null;
    var className = null;
    var java = null;
    var intervalId = null;

    function killJavaProcess() {
      if (java) {
	java.kill();
	java = null;
      }
      if (intervalId) {
	clearInterval(intervalId);
	intervalId = null;
      }
    }

    util.log(id + ' connected');
    sock.send(JSON.stringify({'type': 'state', 'state': 'idle'}));

    sock.on('message', function(message) {
      var req;
      try {
	req = JSON.parse(message);
      } catch (err) {
	sock.send(JSON.stringify({'type': 'error',
				  'text': 'Failed to parse request: ' + err}));
      }

      switch (req.type) {
      case 'compilerun':
	util.log(id + ' compile start');
	killJavaProcess();
	className = getClassName(req.src);
	if (!className) {
	  sock.send(JSON.stringify({'type': 'stderr',
				    'stderr': 'Failed to find public class name.\n'}));
	  sock.send(JSON.stringify({'type': 'state', 'state': 'idle'}));
	  return;
	}
	sock.send(JSON.stringify({'type': 'state', 'state': 'compile'}));
	srcPath = path.join(dir, className + '.java');
	compile(req.src, function(result) {
	  util.log(id + ' compile done (error ' + result.code + ')');
	  if (sock.readyState != ws.OPEN) return;
	  if (result.code == 0) {
	    util.log(id + ' run start');
	    sock.send(JSON.stringify({'type': 'state', 'state': 'run'}));
	    java = child_process.spawn('java',
				       ['-Djava.security.manager',
					'-Djava.security.policy==' + POLICY_FILE,
					'-Xmx' + MAX_JAVA_HEAP,
					'-Xss' + MAX_JAVA_STACK,
					'-cp', dir, className]);
	    java.stdout.on('data', function(stdout) {
	      if (sock.readyState != ws.OPEN) return;
	      sock.send(JSON.stringify({'type': 'stdout',
					'stdout': String(stdout)}));
	    });
	    java.stderr.on('data', function(stderr) {
	      if (sock.readyState != ws.OPEN) return;
	      sock.send(JSON.stringify({'type': 'stderr',
					'stderr': String(stderr)}));
	    });
	    java.on('exit', function(code) {
	      util.log(id + ' run done (error ' + code + ')');
	      java = null;
	      if (intervalId) {
		clearInterval(intervalId);
		intervalId = null;
	      }
	      if (sock.readyState != ws.OPEN) return;
	      sock.send(JSON.stringify({'type': 'stderr',
					'stderr': 'Process terminated.\n'}));
	      sock.send(JSON.stringify({'type': 'state', 'state': 'idle'}));
	    });
	    intervalId = setInterval(function() {
	      if (java) {
		getCPUSeconds(java.pid, function(cpuSeconds) {
		  if (cpuSeconds > MAX_JAVA_CPU_SECONDS) {
		    util.log(id + ' run killed (' +
			     cpuSeconds + ' cpu seconds used)');
		    killJavaProcess();
		    if (sock.readyState != ws.OPEN) return;
		    sock.send(JSON.stringify(
		      {'type': 'stderr',
		       'stderr': 'Process CPU seconds ' + cpuSeconds +
		       ' exceeded ' + MAX_JAVA_CPU_SECONDS + ' second limit.\n'}));
		  }
		});
	      }
	    }, MAX_JAVA_CPU_SECONDS * 100);
	  } else {
	    var errors = parseJavacErrors(result.stderr);
	    sock.send(JSON.stringify({'type': 'compilefail', 'errors': errors}));
	    sock.send(JSON.stringify({'type': 'state', 'state': 'idle'}));
	  }
	});
	break;
      case 'stdin':
	if (java) {
	  java.stdin.write(req.data);
	}
	break;
      case 'stop':
	killJavaProcess();
	if (sock.readyState != ws.OPEN) return;
	sock.send(JSON.stringify({'type': 'state', 'state': 'idle'}));
	break;
      default:
	sock.send(JSON.stringify({'type': 'error',
				  'text': 'Unknown request type: ' + req.type}));
	break;
      }
    });

    sock.on('close', function() {
      util.log(id + ' disconnected');
      killJavaProcess();
      cleanup();
    });

    function compile(src, callback) {
      makeDir();

      function makeDir() {
	fs.mkdir(dir, 0777, function(e) {
	  if (e && e.code != 'EEXIST') throw e;
	  writeSrcFile();
	});
      }

      function writeSrcFile() {
	fs.writeFile(srcPath, src, function(e) {
	  if (e) throw e;
	  runJavac();
	});
      }

      function runJavac() {
	var javac = child_process.spawn('javac', [srcPath]);
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

    function parseJavacErrors(stderr) {
      var errorStart = new RegExp('^' + srcPath + ':(\\d+): (.*)$');
      var lines = stderr.match(/[^\r\n]+/g);
      var errors = [];
      var error = null;
      for (var i = 0; i < lines.length - 1; i++) {
	var match = lines[i].match(errorStart);
	if (match) {
	  error = {line: match[1], text: match[2], detail: '', col: 0};
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
      var match = src.match(/public\s+class\s+(\S+)\s*{/m);
      if (match) {
	return match[1];
      } else {
	return null;
      }
    }

    function cleanup() {
      fs.readdir(dir, function(e, files) {
	if (e && e.code != 'ENOENT') throw e;
	if (!files) {
	  fs.rmdir(dir);
	  return;
	}
	var filesDeleted = 0;
	for (var i = 0; i < files.length; i++) {
	  fs.unlink(path.join(dir, files[i]), function(e) {
	    if (e) throw e;
	    filesDeleted++;
	    if (filesDeleted == files.length) {
	      fs.rmdir(dir);
	    }
	  });
	}
      });
    }
  });
}