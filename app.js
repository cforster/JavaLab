var flatiron = require('flatiron');
var app = flatiron.app;

var async = require('async');
var fs = require('fs');
var path = require('path');
var swig = require('swig');
var url = require('url');

var javaplayserver = require('./javaplayserver');

var labTemplate = swig.compile(String(fs.readFileSync('lab.html')));

app.config.file({ file: path.join(__dirname, 'config', 'config.json') });

app.use(flatiron.plugins.http);
app.use(flatiron.plugins.ecstatic, { root: __dirname });
app.use(javaplayserver);

app.router.get('/lab', function () {
  var app = this;
  var request = url.parse(this.req.url, true);
  var labName = request.query.labName || 'arrays2d';
  fs.readFile(path.join('labs', labName, 'lab.json'), function(e, data) {
    if (e) {
      app.res.writeHead(200, {'Content-type': 'text/plain'});
      app.res.end('Unknown lab ' + labName + '\n' + String(e));
      return;
    }
    var lab = JSON.parse(data);
    async.map(lab.parts, function(f, done) {
      fs.readFile(path.join('labs', labName, f), done);
    }, function(e, results) {
      if (e) {
	app.res.writeHead(200, {'Content-type': 'text/plain'});
	app.res.end('Bad config for lab ' + labName + '\n' + String(e));
	return;
      }
      var parts = [];
      for (var i = 0; i < results.length; i++) {
	parts.push({'name': lab.parts[i], 'text': escape(results[i])});
      }
      var output = labTemplate({'parts': parts});
      app.res.writeHead(200, {'Content-type': 'text/html'});
      app.res.end(output);
    });
  });
});

app.start(80);
