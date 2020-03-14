const GitRepository = require('./git-tools');
const YAML = require('yaml');
const path = require('path');
const fs = {
  ...require('fs'),
  ...require('fs-extra')
};
const d3Node = require('d3-node');

const DIVIDER = '-_-';

module.exports = {
  collect,
  clean,
  report,
  authors
};

function getConfig() {
  const configPath = path.resolve(process.env.GIT_LOG_CONFIG_PATH || './git-log-config.yml');
  const file = fs.readFileSync(configPath, 'utf8');
  return YAML.parse(file);
}

function getRepositoryName(repository) {
  return repository.url.replace(/\W+/g, '-').toLowerCase();
}

function collectUnusedUsers(config) {
  let usedUsers = [];
  for (let team of config.teams) {
    team.users = team.users || [];
    if (team.invert) {
      team.users = usedUsers;
    } else {
      usedUsers = [...usedUsers, ...team.users];
    }
  }
  return usedUsers;
}

function getBranchName(repository, config) {
  return repository.branch || config.branch || 'master';
}

async function collect() {
  const config = getConfig();
  collectUnusedUsers(config);
  const tmpDir = path.resolve(config.tmpDir);
  fs.ensureDirSync(tmpDir);

  for (let repository of config.repositories) {
    try {
      const repositoryName = getRepositoryName(repository);
      const repositoryPath = path.resolve(tmpDir, repositoryName);
      let pathExist = fs.existsSync(repositoryPath);
      let gitRepository = new GitRepository(repositoryPath);

      if (config.cleanTmp || repository.cleanTmp || (pathExist && !(await gitRepository.isGitRepository()))) {
        fs.removeSync(repositoryPath);
        pathExist = false;
      }

      if (!pathExist) {
        fs.ensureDirSync(repositoryPath);
        gitRepository = await GitRepository.clone({
          repo: repository.url,
          dir: repositoryPath,
          branch: getBranchName(repository, config)
        });
      } else {
        await gitRepository.checkout(getBranchName(repository, config));
      }

      for (let team of config.teams) {
        const activeDays = await getActiveDays(gitRepository, repository, team, config);
        if (Object.keys(activeDays).length > 0) {
          const repositoryStatsFileName = `${repositoryName}${DIVIDER}${team.name}${DIVIDER}${Date.now().toString()}.stats.json`;
          fs.writeFileSync(path.resolve(config.dataDir, repositoryStatsFileName), JSON.stringify(activeDays, null, 4));
        }
      }
    } catch (err) {
      if (process.env.DEBUG || config.debug) {
        console.error(err);
      }
    }
  }
}

function readAuthorsFolder(config) {
  let toRemove = [];
  const fileMap = {};
  for (let file of fs.readdirSync(config.dataDir)) {
    if (file.includes('.authors.json')) {
      const line = file.split('.')[0];
      let [repositoryName, timestamp] = line.split(DIVIDER);
      timestamp = Number.parseInt(timestamp, 10);
      const fileKey = repositoryName;
      if (!fileMap[fileKey] || fileMap[fileKey].timestamp < timestamp) {
        if (fileMap[fileKey]) {
          toRemove.push(fileMap[fileKey].file);
        }
        fileMap[fileKey] = {
          repositoryName,
          file,
          timestamp
        };
      } else {
        toRemove.push(file);
      }
    }
  }
  return { fileMap, toRemove };
}

function readStatsFolder(config) {
  let toRemove = [];
  const fileMap = {};
  for (let file of fs.readdirSync(config.dataDir)) {
    if (file.includes('.stats.json')) {
      const line = file.split('.')[0];
      let [repositoryName, team, timestamp] = line.split(DIVIDER);
      timestamp = Number.parseInt(timestamp, 10);
      const fileKey = repositoryName + DIVIDER + team;
      if (!fileMap[fileKey] || fileMap[fileKey].timestamp < timestamp) {
        if (fileMap[fileKey]) {
          toRemove.push(fileMap[fileKey].file);
        }
        fileMap[fileKey] = {
          repositoryName,
          file,
          team,
          timestamp
        };
      } else {
        toRemove.push(file);
      }
    }
  }
  return { fileMap, toRemove };
}

async function clean() {
  const config = getConfig();
  const { toRemove: toRemoveStats } = readStatsFolder(config);
  const { toRemove: toRemoveAuthors } = readAuthorsFolder(config);
  for (let file of [...toRemoveStats, ...toRemoveAuthors]) {
    fs.removeSync(file);
  }
}

async function authors() {
  const config = getConfig();
  const tmpDir = path.resolve(config.tmpDir);
  fs.ensureDirSync(config.authorDir);

  for (let repository of config.repositories) {
    try {
      const repositoryName = getRepositoryName(repository);
      const repositoryPath = path.resolve(tmpDir, repositoryName);
      let gitRepository = new GitRepository(repositoryPath);

      const authors = await gitRepository.authors();
      if (process.env.DEBUG || config.debug) {
        console.log(authors.slice(0, 10));
      }
      if (authors.length > 0) {
        const repositoryAuthorsFileName = `${repositoryName}${DIVIDER}${Date.now().toString()}.authors.json`;
        fs.writeFileSync(path.resolve(config.authorDir, repositoryAuthorsFileName), JSON.stringify(authors, null, 4));
      }
    } catch (err) {
      if (process.env.DEBUG || config.debug) {
        console.error(err);
      }
    }
  }
}

async function report() {
  const config = getConfig();

  const dates = {};
  for (let team of config.teams) {
    dates[team.name] = {};
  }

  const { fileMap } = readStatsFolder(config);

  for (let repository of config.repositories) {
    try {
      const repositoryName = getRepositoryName(repository);
      for (let team of config.teams) {
        const fileKey = repositoryName + DIVIDER + team.name;
        if (fileMap[fileKey]) {
          const activeDays = JSON.parse(fs.readFileSync(path.resolve(config.dataDir, fileMap[fileKey].file), 'utf8'));
          for (let key in activeDays) {
            dates[team.name][key] = (dates[team.name][key] || 0) + activeDays[key];
          }
        }
      }
    } catch (err) {
      if (process.env.DEBUG || config.debug) {
        console.error(err);
      }
    }
  }

  for (let team of config.teams) {
    let compared = [];

    for (const compare of team.compare || []) {
      for (const key in dates[compare]) {
        compared.push(dates[compare][key]);
      }
    }

    makeReport(dates[team.name], team, compared, config);
  }
}

async function getActiveDays(gitRepository, repository, team, config) {
  return await gitRepository.activeDays(
    (email, author) => {
      author = author.toLowerCase();
      email = email.toLowerCase();
      const includes = team.users.includes(author) || team.users.includes(email);
      const exclude = team.exclude && (team.exclude.includes(author) || team.exclude.includes(email));
      const excludeRepository = repository.exclude && (repository.exclude.includes(author) || repository.exclude.includes(email));
      return (team.invert ? !includes : includes) && (!team.exclude || !exclude) && (!repository.exclude || !excludeRepository);
    },
    '--all',
    '--no-merges',
    getBranchName(repository, config)
  );
}

function makeReport(dates, team, compared, config) {
  const output = path.resolve(config.outputDir, team.output);

  let data = [];

  for (let key in dates) {
    data.push({ Date: key, Value: dates[key] });
  }
  // data = require('./data');

  data = data.sort((a, b) => new Date(a.Date) - new Date(b.Date));

  let minYear = Infinity;
  let maxYear = 0;

  const checkYear = date => {
    const year = date.getFullYear();

    if (year > maxYear) {
      maxYear = year;
    }

    if (year < minYear) {
      minYear = year;
    }
  };

  const d3n = new d3Node();
  const d3 = d3n.d3;

  const dateValues = data.map(dv => {
    const date = new Date(dv.Date);
    checkYear(date);
    return {
      date: d3.timeDay(date),
      value: Number(dv.Value)
    };
  });

  if (maxYear === 0) {
    fs.removeSync(output);
    return;
  }

  const yearGap = Math.abs(maxYear - minYear);

  const cellSize = 15;
  const yearHeight = cellSize * 7;
  const marginTop = cellSize * 0.5;
  const marginLeft = 50;
  const marginRight = 10;
  const weeksInYear = 53;

  const [width, height] = [marginLeft + cellSize * (weeksInYear + 1) + marginRight, yearHeight * (yearGap + 1) + 2 * marginTop];

  const svg = d3n.createSVG(width, height);

  const years = d3
    .nest()
    .key(d => d.date.getUTCFullYear())
    .entries(dateValues)
    .reverse();

  const values = dateValues.map(c => c.value);
  let maxValue = d3.max(values);
  let minValue = d3.min(values);

  if (compared.length > 0) {
    const maxValueCompared = d3.max(compared);
    const minValueCompared = d3.min(compared);
    if (maxValueCompared > maxValue) {
      maxValue = maxValueCompared;
    }
    if (minValueCompared > minValue) {
      minValue = minValueCompared;
    }
  }

  const group = svg.append('g');

  const year = group
    .selectAll('g')
    .data(years)
    .join('g')
    .attr('transform', (d, i) => `translate(${marginLeft}, ${yearHeight * i + marginTop})`);

  year
    .append('text')
    .attr('x', -5)
    .attr('y', -30)
    .attr('text-anchor', 'end')
    .attr('font-size', 16)
    .attr('font-weight', 550)
    .attr('font-family', 'Arial')
    .attr('transform', 'rotate(270)')
    .text(d => d.key);

  const formatDay = d => ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][d.getUTCDay()];
  const countDay = d => d.getUTCDay();
  const timeWeek = d3.utcSunday;
  const formatDate = d3.utcFormat('%x');
  const colorFn = d3.scaleSequential(d3.interpolateBuGn).domain([Math.floor(minValue), Math.ceil(maxValue)]);

  year
    .append('g')
    .attr('text-anchor', 'end')
    .selectAll('text')
    .data(d3.range(7).map(i => new Date(1995, 0, i)))
    .join('text')
    .attr('x', -5)
    .attr('y', d => (countDay(d) + 0.5) * cellSize)
    .attr('dy', '0.31em')
    .attr('font-size', 12)
    .text(formatDay);

  year
    .append('g')
    .selectAll('rect')
    .data(d => d.values)
    .join('rect')
    .attr('width', cellSize - 1.5)
    .attr('height', cellSize - 1.5)
    .attr('x', (d, i) => timeWeek.count(d3.utcYear(d.date), d.date) * cellSize + 10)
    .attr('y', d => countDay(d.date) * cellSize + 0.5)
    .attr('fill', d => colorFn(d.value))
    .append('title')
    .text(d => `${formatDate(d.date)}: ${d.value.toFixed(2)}`);

  fs.writeFileSync(output, d3n.svgString());
}
