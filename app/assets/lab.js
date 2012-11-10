function LabCtrl($scope) {
  $scope.user = 'matt';
  $scope.lab = 'arrays2d';
  $scope.servermsg = "disconnected";

  var socket = new WebSocket('ws://' + document.location.host + '/labserver');
  socket.onopen = function(event) {
    $scope.$apply(function() {
      $scope.servermsg = "idle";
      socket.send(JSON.stringify({type: 'setUser', user: $scope.user}));
      socket.send(JSON.stringify({type: 'setLab', lab: $scope.lab}));
    });
  }
  socket.onmessage = function(event) {
    $scope.$apply(function() {
      var r = JSON.parse(event.data);
      switch (r.type) {
      case 'error':
        console.log(r.text);
        break;
      case 'updateLabParts':
        $scope.parts = [];
        for (var i = 0; i < r.labParts.length; i++) {
          $scope.parts.push({name: r.labParts[i]});
        }
        if ($scope.activePart) {
          var activePartIndex = r.labParts.indexOf($scope.activePart.name);
          if (activePartIndex != -1) {
            $scope.switchPart($scope.parts[activePartIndex]);
          } else {
            $scope.switchPart($scope.parts[0] || null);
          }
        } else {
          $scope.switchPart($scope.parts[0] || null);
        }
        break;
      }
    });
  }
  socket.onerror = socket.onclose = function(event) {
    $scope.$apply(function() {
      $scope.servermsg = "disconnected";
    });
  }

  $scope.showErrors = false;
  $scope.showOutput = false;

  $scope.errors = [
    {line: '3', col: 10, text: 'error one', detail: 'error\ndetail\nhere'},
    {line: '5', col: 4, text: 'error two', detail: 'error2\ndetail\nhere'},
    {line: '6', col: 1, text: 'error three', detail: 'error3\ndetail\nhere'}
  ];
  $scope.selectedError = $scope.errors[0];
  $scope.onErrorSelect = function() {
    $scope.editor.gotoLine($scope.selectedError.line, $scope.selectedError.col);
  }

  var editorDoc = null;
  $scope.newPartPattern = /^[A-Za-z0-9]*$/;
  $scope.parts = [];
  $scope.activePart = null;
  $scope.switchPart = function(part) {
    $scope.activePart = part;
    if (part == null) {
      if (editorDoc) {
        editorDoc.detach_ace();
        editorDoc.close(function() {
          $scope.editor.setValue('');
        });
      }
    } else {
      function openDoc() {
        sharejs.open(
          $scope.user + ':' + $scope.lab + ':' + part.name,
          'text',
          function(e, doc) {
            if (e) return console.log(e);
            editorDoc = doc;
            doc.attach_ace($scope.editor);
            $scope.editor.gotoLine(1, 0, false);
            $scope.editor.scrollToRow(0);
          });
      }
      if (editorDoc) {
        editorDoc.detach_ace();
        editorDoc.close(openDoc);
      } else {
        openDoc();
      }
    }
  }
  $scope.removePart = function(part) {
    var i = $scope.parts.indexOf(part);
    $scope.parts.splice(i, 1);
    if ($scope.activePart == part) {
      if (i == $scope.parts.length) i--;
      $scope.switchPart($scope.parts.length == 0 ? null : $scope.parts[i]);
    }
  }
  $scope.newPart = function() {
    if (newPartForm.$invalid || !$scope.newPartName)
      return;

    var unique = true;
    angular.forEach($scope.parts, function(part) {
      if (part.name == $scope.newPartName) unique = false;
    });
    if (!unique) {
      $scope.newPartName = '';
      return;
    }

    var newPart = {name: $scope.newPartName};
    $scope.newPartName = '';
    $scope.parts.push(newPart);
    $scope.switchPart(newPart);
  }

  $scope.initEditor = function() {
    $scope.editor = ace.edit("editor");
    $scope.editor.setTheme("ace/theme/chrome");
    $scope.editor.getSession().setMode("ace/mode/java");
    $scope.editor.setPrintMarginColumn(100);
    $scope.editor.getSession().setUseSoftTabs(true);
    $scope.editor.getSession().setTabSize(2);
  }

  var termStdinStart = 0;
  function termStdout(stdoutData) {
    var term = $('#terminal')[0];
    var stdinData = '';
    if (term.value.length > termStdinStart) {
      stdinData = term.value.substr(termStdinStart);
      term.value = term.value.substring(0, termStdinStart);
    }
    term.value += stdoutData;
    termStdinStart += stdoutData.length;
    if (stdinData) {
      term.value += stdinData;
    }
  }
  $scope.initTerminal = function() {
    termStdout('line one\n');
    termStdout('prompt>');
    var term = $('#terminal')[0];
    $('#terminal').keydown(function(event) {
      if (event.which == 8) {
        if (term.value.length > termStdinStart) {
          term.value = term.value.substring(0, term.value.length - 1);
        }
        term.scrollTop = term.scrollHeight;
        event.preventDefault();
      } else if (event.which == 13) {
        term.value += '\n';
        var stdinData = term.value.substr(termStdinStart);
        termStdinStart = term.value.length;
        // TODO: upload stdinData
        term.scrollTop = term.scrollHeight;
        event.preventDefault();
      }
    });
    $('#terminal').keypress(function(event) {
      if (event.which > 31 && event.which < 127) {
        term.value += String.fromCharCode(event.which);
        term.scrollTop = term.scrollHeight;
        event.preventDefault();
      }
    });
    $('#terminal').bind('paste', function(event) {
      event.preventDefault();
    });
  }
}